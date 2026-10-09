import { createClient } from "@supabase/supabase-js";

const _rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const url = _rawUrl ? (() => { try { return new URL(_rawUrl).origin; } catch { return _rawUrl; } })() : undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(url && anonKey);
export const supabase = hasSupabaseConfig
  ? createClient(url!, anonKey!)
  : null;
