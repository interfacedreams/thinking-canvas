// The app mark: three canvas cards — sky, rose, sage from the node palette —
// wired together, mirroring what the product is. Transparent background so it
// sits on any surface; the dock/app icon adds its own white plate (build/icon.svg).
function CanvasMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true">
      <line x1="27" y1="29" x2="46" y2="70" stroke="#B2CE7E" strokeWidth={3} strokeLinecap="round" />
      <line x1="71" y1="24" x2="46" y2="70" stroke="#E398AB" strokeWidth={3} strokeLinecap="round" />
      <line x1="27" y1="29" x2="71" y2="24" stroke="#8FBEE3" strokeWidth={3} strokeLinecap="round" />
      <rect x="10" y="18" width="34" height="22" rx="6" fill="#E1EFFA" stroke="#8FBEE3" strokeWidth={2.5} />
      <rect x="56" y="14" width="30" height="20" rx="6" fill="#FBE3E7" stroke="#E398AB" strokeWidth={2.5} />
      <rect x="28" y="58" width="36" height="24" rx="6" fill="#EAF2D9" stroke="#B2CE7E" strokeWidth={2.5} />
    </svg>
  )
}

export default CanvasMark
