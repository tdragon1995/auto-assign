/** Supplied application logos beside the shared refresh icon. */
export function DataSourceIcon({ source, className = "size-5" }: {source: "cartrack" | "misa" | "labcenter" | "supabase"; className?: string}) {
  if (source !== "supabase") return <img src={`/integrations/${source}.png`} alt="" aria-hidden="true" width={20} height={20} className={`${className} shrink-0 object-contain`} />;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} shrink-0`}>
    <path d="M13.5 1 2 15h11.5Z" fill="#3ecf8e"/><path d="M10.5 23 22 9H10.5Z" fill="#22a86f"/>
  </svg>;
}
