import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Supabase 클라이언트 초기화
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase 환경 변수가 설정되지 않았습니다. 원문 저장 기능이 비활성화됩니다.')
}

// Supabase 클라이언트 생성
export const supabase = createClient(
  supabaseUrl || '',
  supabaseKey || ''
)

// Supabase 클라이언트가 제대로 설정되었는지 확인
export const isSupabaseConfigured = !!supabaseUrl && !!supabaseKey 