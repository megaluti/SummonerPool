import { createClient } from "@supabase/supabase-js";

function resolveSupabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch (_) {
    return raw.replace(/\/+$/, "");
  }
}

const url = resolveSupabaseUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined);
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(url && anonKey);
export const supabase = hasSupabaseConfig
  ? createClient(url!, anonKey!)
  : null;
