import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AuthStatus,
  CanvasDoc,
  ChosenFile,
  FolderState,
  NoteVersion,
  PermissionReply,
  PermissionSettings,
  PersistedMessage,
  ThreadEvent,
  ThreadSendArgs
} from '../shared/types'

// Custom APIs for renderer
const api = {
  auth: {
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    setToken: (token: string): Promise<AuthStatus> => ipcRenderer.invoke('auth:setToken', token),
    clearToken: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:clearToken'),
    setApiKey: (key: string): Promise<AuthStatus> => ipcRenderer.invoke('auth:setApiKey', key),
    clearApiKey: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:clearApiKey')
  },
  settings: {
    permissions: (): Promise<PermissionSettings> => ipcRenderer.invoke('settings:permissions:get'),
    setPermissions: (patch: Partial<PermissionSettings>): Promise<PermissionSettings> =>
      ipcRenderer.invoke('settings:permissions:set', patch)
  },
  folder: {
    get: (): Promise<FolderState> => ipcRenderer.invoke('folder:get'),
    choose: (): Promise<FolderState | null> => ipcRenderer.invoke('folder:choose'),
    select: (path: string): Promise<FolderState> => ipcRenderer.invoke('folder:select', path),
    create: (name: string, parent?: string): Promise<FolderState | null> =>
      ipcRenderer.invoke('folder:create', name, parent),
    pickCreateParent: (): Promise<string | null> => ipcRenderer.invoke('folder:pickCreateParent')
  },
  canvas: {
    load: (): Promise<CanvasDoc | null> => ipcRenderer.invoke('canvas:load'),
    save: (doc: CanvasDoc): Promise<void> => ipcRenderer.invoke('canvas:save', doc),
    saveThread: (nodeId: string, messages: PersistedMessage[]): Promise<void> =>
      ipcRenderer.invoke('canvas:saveThread', nodeId, messages),
    deleteThread: (nodeId: string): Promise<void> =>
      ipcRenderer.invoke('canvas:deleteThread', nodeId)
  },
  note: {
    create: (nodeId: string): Promise<void> => ipcRenderer.invoke('note:create', nodeId),
    rename: (nodeId: string, title: string): Promise<{ title: string } | null> =>
      ipcRenderer.invoke('note:rename', nodeId, title),
    save: (nodeId: string, content: string): Promise<void> =>
      ipcRenderer.invoke('note:save', nodeId, content),
    restore: (
      nodeId: string,
      index: number
    ): Promise<{ content: string; versions: NoteVersion[] } | null> =>
      ipcRenderer.invoke('note:restore', nodeId, index),
    // A 1-3 sentence index blurb for a note's content (Haiku one-shot).
    describe: (content: string): Promise<string | null> =>
      ipcRenderer.invoke('note:describe', content),
    // The current generated MEMORY.md text (the project memory index), or ''.
    readMemory: (): Promise<string> => ipcRenderer.invoke('note:readMemory'),
    delete: (nodeId: string): Promise<void> => ipcRenderer.invoke('note:delete', nodeId)
  },
  file: {
    choose: (): Promise<ChosenFile | null> => ipcRenderer.invoke('file:choose'),
    // Absolute path of a File dragged in from the OS ('' when it has none,
    // e.g. an image dragged out of a browser). File.path is gone in modern
    // Electron; webUtils is the sanctioned bridge.
    pathFor: (file: File): string => webUtils.getPathForFile(file),
    fromPath: (path: string): Promise<ChosenFile | null> =>
      ipcRenderer.invoke('file:fromPath', path),
    // An image on the clipboard, staged to a temp file for attach.
    fromClipboard: (): Promise<ChosenFile | null> => ipcRenderer.invoke('file:fromClipboard'),
    attach: (sourcePath: string): Promise<{ file: string } | null> =>
      ipcRenderer.invoke('file:attach', sourcePath),
    // PDF bytes for the inline viewer; Buffers arrive here as Uint8Array.
    pdfData: (rel: string): Promise<Uint8Array | null> => ipcRenderer.invoke('file:pdfData', rel),
    // A 1-3 sentence index blurb for a pinned image/PDF (vision Haiku one-shot).
    describe: (rel: string): Promise<string | null> => ipcRenderer.invoke('file:describe', rel),
    // Remove a media card's backing file from the folder (card + file deleted together).
    delete: (rel: string): Promise<void> => ipcRenderer.invoke('file:delete', rel)
  },
  link: {
    // Save a pinned page's Defuddle markdown as a hidden clip the agent can Read.
    // The renderer extracts (only it reaches the live tab); main writes the file.
    clip: (
      nodeId: string,
      payload: { title?: string; url: string; markdown: string }
    ): Promise<boolean> => ipcRenderer.invoke('link:clip', nodeId, payload),
    // Remove a link's clip — on unpin or delete.
    unclip: (nodeId: string): Promise<void> => ipcRenderer.invoke('link:unclip', nodeId)
  },
  chat: {
    // Snapshot a pinned chat's transcript to a hidden clip the agent can Read.
    // The renderer builds the transcript (its messages live there); main writes it.
    clipMemory: (
      nodeId: string,
      payload: { title?: string; transcript: string }
    ): Promise<boolean> => ipcRenderer.invoke('chat:clipMemory', nodeId, payload),
    // Remove a chat's transcript clip — on unpin or delete.
    unclipMemory: (nodeId: string): Promise<void> => ipcRenderer.invoke('chat:unclipMemory', nodeId)
  },
  thread: {
    send: (args: ThreadSendArgs): Promise<void> => ipcRenderer.invoke('thread:send', args),
    title: (conversation: string): Promise<string | null> =>
      ipcRenderer.invoke('thread:title', conversation),
    respondPermission: (reply: PermissionReply): void => {
      ipcRenderer.send('thread:permission', reply)
    },
    onEvent: (cb: (event: ThreadEvent) => void): void => {
      ipcRenderer.on('thread:event', (_e, payload: ThreadEvent) => cb(payload))
    }
  },
  updates: {
    // Fires while an opted-in update downloads; done=true when the bytes are in
    // (the restart prompt takes over from there).
    onProgress: (cb: (p: { percent: number; done: boolean }) => void): void => {
      ipcRenderer.on('update:progress', (_e, p: { percent: number; done: boolean }) => cb(p))
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api
