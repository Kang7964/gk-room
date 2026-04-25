import { createClient } from '@supabase/supabase-js'

const supabaseUrl = "https://xqcbkpkcpabtcdyorqfc.supabase.co"
const supabaseKey = "sb_publishable_YevwEdLH46JjMR3BmRH66g_DJr1jbe9"

export const supabase = createClient(supabaseUrl, supabaseKey)