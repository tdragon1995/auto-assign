/** Compact source marks beside the shared refresh icon. */
export function DataSourceIcon({ source, className = "size-5" }: {source: "cartrack" | "misa" | "labcenter" | "supabase"; className?: string}) {
  if (source === "misa") return <img src="/integrations/misa.ico" alt="" aria-hidden="true" width={20} height={20} className={`${className} shrink-0`} />;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} shrink-0`}>
    {source === "cartrack" ? <><circle cx="12" cy="12" r="11" fill="#e89467"/><path d="m5.5 17 6.5-12 6.5 12-6.5-5Z" fill="white"/><circle cx="12" cy="3.6" r="1.2" fill="white"/></>
      : source === "labcenter" ? <><rect x="1" y="1" width="22" height="22" rx="3" fill="#5278c8"/><path d="M17 6H10a4 4 0 0 0 0 8h4a2 2 0 0 1 0 4H7" fill="none" stroke="white" strokeWidth="2.8" strokeLinecap="round"/></>
      : <><path d="M13.5 1 2 15h11.5Z" fill="#3ecf8e"/><path d="M10.5 23 22 9H10.5Z" fill="#22a86f"/></>}
  </svg>;
}
