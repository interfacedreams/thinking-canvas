import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ThreadEvent } from '../shared/types'
import { isSafeNodeId, widgetFileFor } from './paths'
import { MAX_WIDGET_HTML, WIDGET_PKG_NAMES, readWidgetMeta, saveWidgetHtml } from './widgets'

// The canvas MCP server: the agent's hands on the canvas itself. For now that
// means widgets — AI-authored HTML cards. create_widget persists the HTML to
// .canvas/widgets/<id>.html and emits a widget-created event; the renderer
// materializes the card beside the chat, wired to that chat alone.
// update_widget rewrites an existing card in place. All tools here are
// auto-allowed in canUseTool: they only ever touch the widgets dir, and the
// result renders inside a sandboxed, no-network iframe.

const PKG_NAMES = WIDGET_PKG_NAMES as [string, ...string[]]

// Exact hostnames only — no schemes, paths, ports or wildcards.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** Build the per-turn canvas server. `emit` streams widget events to the
 *  renderer, which owns node placement and wiring. */
export function createCanvasServer(
  root: string,
  nodeId: string,
  emit: (payload: ThreadEvent) => void
): McpSdkServerConfigWithInstance {
  const createWidget = tool(
    'create_widget',
    'Create an interactive HTML widget card on the canvas next to this chat, wired to it. ' +
      'Follow the WIDGETS authoring rules in your system prompt (self-contained document, ' +
      'packages, window.canvas API). Prefer one good widget over several small ones; revise ' +
      'an existing one with update_widget instead of creating near-duplicates.',
    {
      title: z.string().min(1).max(80).describe('Short human title shown in the card header'),
      html: z
        .string()
        .min(1)
        .max(MAX_WIDGET_HTML)
        .describe('The complete self-contained HTML document'),
      width: z.number().optional().describe('Card width hint in px (280-600, default 480)'),
      height: z
        .number()
        .optional()
        .describe('Card height hint in px (200-1280, default 400); content scrolls beyond it'),
      packages: z
        .array(z.enum(PKG_NAMES))
        .optional()
        .describe('Vendored packages to inject before your code (see PACKAGES)'),
      net: z
        .array(z.string().regex(HOSTNAME_RE))
        .max(8)
        .optional()
        .describe('Exact hostnames canvas.fetch may GET (e.g. ["api.open-meteo.com"])')
    },
    async (args) => {
      const widgetId = randomUUID()
      await saveWidgetHtml(root, widgetId, args.html, {
        packages: args.packages ?? [],
        net: args.net ?? []
      })
      emit({
        nodeId,
        type: 'widget-created',
        widgetId,
        title: args.title,
        html: args.html.slice(0, MAX_WIDGET_HTML),
        ...(args.width != null ? { width: args.width } : {}),
        ...(args.height != null ? { height: args.height } : {})
      })
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Created widget "${args.title}" (widget_id: ${widgetId}). It is on the canvas, ` +
              'connected to this chat. Use update_widget with this id to revise it.'
          }
        ]
      }
    }
  )

  const updateWidget = tool(
    'update_widget',
    'Rewrite an existing widget wholesale: pass the complete replacement HTML (no diffs) and ' +
      'the card re-renders in place — same spot, same wiring. widget_id comes from ' +
      "create_widget's result or a <widget id=…> block in your context.",
    {
      widget_id: z.string().describe('The widget id (from create_widget or a <widget id=…> block)'),
      html: z
        .string()
        .min(1)
        .max(MAX_WIDGET_HTML)
        .describe('The complete replacement HTML document'),
      title: z.string().min(1).max(80).optional().describe('Optionally retitle the card'),
      packages: z
        .array(z.enum(PKG_NAMES))
        .optional()
        .describe('Replace the injected package list (omit to keep the current one)'),
      net: z
        .array(z.string().regex(HOSTNAME_RE))
        .max(8)
        .optional()
        .describe('Replace the canvas.fetch host allowlist (omit to keep the current one)')
    },
    async (args) => {
      if (!isSafeNodeId(args.widget_id)) {
        return {
          content: [{ type: 'text' as const, text: `Unknown widget id: ${args.widget_id}` }],
          isError: true
        }
      }
      try {
        await fs.access(widgetFileFor(root, args.widget_id))
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `No widget exists with id ${args.widget_id}. Create one with create_widget, or ` +
                'check the <widget id=…> blocks in your context for the right id.'
            }
          ],
          isError: true
        }
      }
      // Omitted grants carry over — an update shouldn't silently drop (or
      // need to restate) the widget's packages and net allowlist.
      const prev = await readWidgetMeta(root, args.widget_id)
      await saveWidgetHtml(root, args.widget_id, args.html, {
        packages: args.packages ?? prev?.packages ?? [],
        net: args.net ?? prev?.net ?? []
      })
      emit({
        nodeId,
        type: 'widget-updated',
        widgetId: args.widget_id,
        html: args.html.slice(0, MAX_WIDGET_HTML),
        ...(args.title ? { title: args.title } : {})
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated widget ${args.widget_id} — the card re-rendered.`
          }
        ]
      }
    }
  )

  const showInlineWidget = tool(
    'show_inline_widget',
    'Render a compact HTML visual INLINE in your current reply — it appears in the transcript ' +
      'at the point of this call and scrolls with the conversation (chat width, ~560px). Same ' +
      'WIDGETS authoring rules as create_widget. Rule of thumb: inline if the visual is part ' +
      'of this answer; create_widget if it is an artifact the user will keep, revisit, or ' +
      'interact with beyond this reply.',
    {
      html: z
        .string()
        .min(1)
        .max(MAX_WIDGET_HTML)
        .describe('The complete self-contained HTML document for the block'),
      height: z
        .number()
        .optional()
        .describe('Block height in px (80-800, default 260) — content scrolls beyond it'),
      packages: z
        .array(z.enum(PKG_NAMES))
        .optional()
        .describe('Vendored packages to inject before your code (see create_widget)'),
      net: z
        .array(z.string().regex(HOSTNAME_RE))
        .max(8)
        .optional()
        .describe('Exact hostnames canvas.fetch may GET')
    },
    async (args) => {
      const widgetId = randomUUID()
      await saveWidgetHtml(root, widgetId, args.html, {
        packages: args.packages ?? [],
        net: args.net ?? []
      })
      emit({
        nodeId,
        type: 'widget-inline',
        widgetId,
        ...(args.height != null ? { height: args.height } : {})
      })
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Rendered inline widget ${widgetId} in the reply. Continue your answer after it; ` +
              'do not repeat its content as text.'
          }
        ]
      }
    }
  )

  const setWidgetData = tool(
    'set_widget_data',
    'Push a data payload into a live widget WITHOUT rewriting its HTML — delivered to the ' +
      'widget\'s canvas.on("data", handler). Use this for cheap refreshes (new numbers into an ' +
      'existing chart, stamping fresh conditions onto a map) when the layout already fits; use ' +
      'update_widget when the structure itself changes. No-op if the widget declared no ' +
      '"data" handler.',
    {
      widget_id: z.string().describe('The widget id (from create_widget or a <widget id=…> block)'),
      data: z
        .string()
        .max(100_000)
        .describe('The payload as a JSON string — parsed and handed to the handler')
    },
    async (args) => {
      if (!isSafeNodeId(args.widget_id)) {
        return {
          content: [{ type: 'text' as const, text: `Unknown widget id: ${args.widget_id}` }],
          isError: true
        }
      }
      let payload: unknown
      try {
        payload = JSON.parse(args.data)
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'data must be valid JSON' }],
          isError: true
        }
      }
      emit({ nodeId, type: 'widget-data', widgetId: args.widget_id, payload })
      return {
        content: [
          { type: 'text' as const, text: `Delivered the payload to widget ${args.widget_id}.` }
        ]
      }
    }
  )

  return createSdkMcpServer({
    name: 'canvas',
    version: '1.0.0',
    tools: [createWidget, updateWidget, showInlineWidget, setWidgetData]
  })
}

// Nudges the model toward the tool without hijacking ordinary answers —
// appended to every chat turn's system prompt (not note-editing turns).
export const WIDGET_APPEND =
  'WIDGETS — you can put interactive HTML cards on the canvas with create_widget (revise with ' +
  'update_widget) and render smaller visuals inside a reply with show_inline_widget; use them ' +
  'when the user asks or when a visualization genuinely beats prose, never for answers that ' +
  'read fine as text (and never write raw HTML into chat text or files — widget tools are the ' +
  'sanctioned visual output). Rule of thumb: inline if the visual is part of this answer; ' +
  'canvas widget if it is an artifact the user will keep, revisit, or interact with beyond ' +
  'this reply.\n' +
  'Authoring rules: pass one complete, self-contained HTML document (inline <style>/<script>) ' +
  'styled to sit on a warm paper card (#FFFDF6). The sandbox has no network — no CDNs, ' +
  'external files, fetch/XHR, or remote images (data: URIs work). ' +
  'Show the data: every value must be readable at a glance — never hidden behind hover states ' +
  'or tooltips. Label bars/points/segments directly with their values; in Chart.js disable ' +
  'tooltips ({ plugins: { tooltip: { enabled: false } } }) and draw the numbers on the chart. ' +
  'Use interaction sparingly: the best widget is usually a great static view of the data — ' +
  'add buttons, filters, or controls only when the user asked for them or the data is ' +
  'genuinely unusable without them. ' +
  'The `packages` param ' +
  'injects pinned local libraries as globals: "canvas-ui" (canvas-native CSS — prefer it), ' +
  '"chart" (Chart.js 4 → Chart), "leaflet" (1.9 → L; tiles MUST use ' +
  'L.tileLayer("widget-tile://osm/{z}/{x}/{y}.png")), "d3" (v7), "dayjs", "markdown" ' +
  '(markdownit + DOMPurify). An injected window.canvas API provides prompt(text) — sends a ' +
  'real user turn to the connected chat, so wire it only to buttons that genuinely need you — ' +
  'fetch(url), a brokered GET resolving like fetch but restricted to hostnames declared in ' +
  'the `net` param at creation, and on("data", handler) for set_widget_data payloads. The ' +
  "chat is a widget's only counterparty — no messaging to tabs, notes, or other widgets."

/** Connected widgets as system-prompt blocks, mirroring the <note>/<page>
 *  framing — ids included so update_widget can address them. */
export function widgetsAppend(widgets: { id: string; title: string; html: string }[]): string {
  if (widgets.length === 0) return ''
  return (
    'The user has widgets (interactive HTML cards you authored) wired to this conversation. ' +
    'Their current HTML is below with their ids — revise one with update_widget(widget_id, ' +
    'html) instead of creating a duplicate.\n\n' +
    widgets
      .map(
        (w) =>
          `<widget id=${JSON.stringify(w.id)} title=${JSON.stringify(w.title)}>\n${w.html}\n</widget>`
      )
      .join('\n')
  )
}
