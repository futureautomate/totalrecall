export const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "—";
export const shortPath = (p: string) => { const parts = p.split(/[\\/]/).filter(Boolean); return parts.slice(-2).join("/"); };
