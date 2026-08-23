import { createClient } from '@supabase/supabase-js'

// Both values are public by design: the publishable key is meant to ship in
// the bundle, and the row-level security policies are what guard the data.
export const supabase = createClient(
  'https://iiezmyshdtrudyoezvqx.supabase.co',
  'sb_publishable_sy7jNwi3uTDAAl6bwV9d8A_-aaEBGRO',
)
