import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateString: string | undefined | null) {
  if (!dateString) return "—";
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return "—";
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) {
    return "—";
  }
}

export function formatMetric(val: number | null | undefined, decimals = 3) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return "—";
  return val.toFixed(decimals);
}
