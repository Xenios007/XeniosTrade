// A plain <a href> click has been observed to silently no-op for some
// cross-host (ai.localhost/bot.localhost) navigations in local dev - server,
// bundle and DOM all checked out fine, and the href works when pasted
// directly, so this is some local browser/profile click-handling quirk, not a
// code bug. Used anywhere a link crosses from one workspace host to another
// (getModeUrl) so navigation does not depend on native click-to-navigate
// behavior working.
export function ExternalHostLink({ href, className, children, ...rest }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (href) {
          event.preventDefault()
          window.location.assign(href)
        }
      }}
      className={className}
      {...rest}
    >
      {children}
    </a>
  )
}
