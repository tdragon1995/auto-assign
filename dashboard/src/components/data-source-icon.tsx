/** Supplied application logos beside the shared refresh icon. */
export function DataSourceIcon({ source, className = "size-5" }: {source: "cartrack" | "misa" | "labcenter" | "supabase"; className?: string}) {
  // Crop supplied image padding so each visible logo fills the same circular diameter.
  if (source === "labcenter" || source === "misa") return <svg viewBox={source === "labcenter" ? "9 11 24 24" : "17 20 63 63"} aria-hidden="true" className={`${className} shrink-0 rounded-full overflow-hidden`}><image href={`/integrations/${source}.png`} width={source === "labcenter" ? 44 : 88} height={source === "labcenter" ? 49 : 92} /></svg>;
  if (source !== "supabase") return <img src={`/integrations/${source}.png`} alt="" aria-hidden="true" width={20} height={20} className={`${className} shrink-0 rounded-full object-cover`} />;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} shrink-0 rounded-full`}>
    <path d="M13.5 1 2 15h11.5Z" fill="#3ecf8e"/><path d="M10.5 23 22 9H10.5Z" fill="#22a86f"/>
  </svg>;
}
