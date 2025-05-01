-- SQL 함수 정의: article_contents 테이블 생성
CREATE OR REPLACE FUNCTION create_article_contents_table()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER 
AS $$
BEGIN
  -- 테이블이 없는 경우에만 생성
  IF NOT EXISTS (
    SELECT FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename = 'article_contents'
  ) THEN
    CREATE TABLE public.article_contents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      story_id TEXT NOT NULL,
      headline TEXT,
      content_full TEXT,
      storage_path TEXT,
      content_length INTEGER,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      
      -- 검색 효율성을 위한 인덱스
      CONSTRAINT unique_story_id UNIQUE (story_id)
    );
    
    -- 권한 설정
    ALTER TABLE public.article_contents ENABLE ROW LEVEL SECURITY;
    
    -- 인증된 요청에 대한 모든 작업 허용
    CREATE POLICY "인증된 사용자에게 모든 권한 부여" ON public.article_contents
      FOR ALL USING (auth.role() = 'authenticated');
      
    -- 익명 사용자에게 읽기 권한만 부여
    CREATE POLICY "익명 사용자에게 읽기 권한만 부여" ON public.article_contents
      FOR SELECT USING (auth.role() = 'anon');
  END IF;
END;
$$; 