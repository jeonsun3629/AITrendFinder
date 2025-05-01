import { supabase, isSupabaseConfigured } from '../utils/supabase'
import { ApiCache } from '../utils/apiCache'

/**
 * 원문 저장 방식
 */
export enum StorageMethod {
  DATABASE = 'database',
  STORAGE = 'storage',
  NONE = 'none'
}

/**
 * 원문 저장 결과 인터페이스
 */
interface ContentStorageResult {
  id?: string;
  storyId: string;
  method: StorageMethod;
  path?: string;
  size?: number;
}

/**
 * 원문 저장소 인터페이스
 */
interface ContentStorageItem {
  id: string;
  story_id: string;
  headline?: string;
  content_full?: string;
  storage_path?: string;
  content_length?: number;
  created_at: string;
}

// 데이터베이스에 직접 저장하는 최대 콘텐츠 길이 증가 (100KB → 500KB)
const MAX_DB_CONTENT_SIZE = 500000;

// 테이블 이름
const CONTENTS_TABLE = 'article_contents';
const STORAGE_BUCKET = 'article-contents';

/**
 * 필요한 테이블과 버킷이 존재하는지 확인하고 없으면 생성
 */
async function ensureStorageStructure() {
  if (!isSupabaseConfigured) {
    console.log('Supabase가 설정되지 않았습니다. 테이블 생성을 건너뜁니다.');
    return false;
  }

  try {
    // 테이블 존재 여부 확인
    const { error: tableCheckError } = await supabase
      .from(CONTENTS_TABLE)
      .select('id')
      .limit(1);

    // 테이블이 없으면 생성
    if (tableCheckError && tableCheckError.message.includes('does not exist')) {
      console.error(`테이블 '${CONTENTS_TABLE}'이 존재하지 않습니다.`);
      console.error(`Supabase 대시보드에서 SQL 에디터를 열고 다음 SQL을 실행하세요:`);
      console.error(`
CREATE TABLE IF NOT EXISTS ${CONTENTS_TABLE} (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id TEXT NOT NULL,
  headline TEXT,
  content_full TEXT,
  storage_path TEXT,
  content_length INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_story_id UNIQUE (story_id)
);

-- 권한 설정 (필요한 경우)
ALTER TABLE public.${CONTENTS_TABLE} ENABLE ROW LEVEL SECURITY;
      `);
      return false;
    }

    // 스토리지 버킷 확인
    const { data: buckets, error: bucketError } = await supabase
      .storage
      .listBuckets();

    if (bucketError) {
      console.error('스토리지 버킷 확인 실패:', bucketError.message);
      return false;
    }

    const bucketExists = buckets.some(bucket => bucket.name === STORAGE_BUCKET);
    
    // 버킷이 없으면 생성
    if (!bucketExists) {
      console.error(`버킷 '${STORAGE_BUCKET}'이 존재하지 않습니다.`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('스토리지 구조 확인 중 오류:', error);
    return false;
  }
}

/**
 * 전체 원문을 Supabase에 저장
 * 
 * @param storyId 스토리 ID (고유 식별자)
 * @param headline 헤드라인
 * @param content 전체 원문 내용
 * @returns 저장 결과
 */
export async function storeFullContent(
  storyId: string,
  headline: string,
  content: string
): Promise<ContentStorageResult> {
  // Supabase가 설정되지 않은 경우
  if (!isSupabaseConfigured) {
    console.log(`Supabase가 설정되지 않아 원문 저장을 건너뜁니다: ${headline}`);
    return { storyId, method: StorageMethod.NONE };
  }
  
  try {
    // 테이블과 버킷 확인 및 생성
    await ensureStorageStructure();
    
    // 콘텐츠가 없는 경우
    if (!content || content.trim() === '') {
      console.log(`콘텐츠가 비어있어 저장을 건너뜁니다: ${headline}`);
      return { storyId, method: StorageMethod.NONE };
    }
    
    console.log(`원문 저장 시작: ${headline} (${content.length} 바이트)`);
    
    // 캐시 키 생성
    const cacheKey = `content:${storyId}`;
    
    // 이미 저장된 내용이 있는지 확인
    const { data: existingData } = await supabase
      .from(CONTENTS_TABLE)
      .select('id')
      .eq('story_id', storyId)
      .maybeSingle();
    
    if (existingData?.id) {
      console.log(`이미 저장된 콘텐츠가 있습니다: ${headline}`);
      
      // 캐시에 저장
      ApiCache.set(cacheKey, {
        storyId,
        id: existingData.id,
        method: StorageMethod.DATABASE  // 간단히 데이터베이스로 가정
      });
      
      return { 
        storyId, 
        id: existingData.id, 
        method: StorageMethod.DATABASE 
      };
    }
    
    // 콘텐츠 길이에 따라 저장 방식 결정
    const contentLength = content.length;
    
    // 원문과 헤드라인의 ID값을 명확하게 로깅
    console.log(`저장 중인 storyId: ${storyId}, 헤드라인: ${headline}`);
    
    // 1. 텍스트가 짧은 경우 데이터베이스에 직접 저장
    if (contentLength < MAX_DB_CONTENT_SIZE) {
      // 최신 레코드 확인
      const { data: latestRecord } = await supabase
        .from(CONTENTS_TABLE)
        .select('story_id, headline')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (latestRecord) {
        console.log(`최근 저장된 레코드 - story_id: ${latestRecord.story_id}, headline: ${latestRecord.headline}`);
      }
      
      const { data, error } = await supabase
        .from(CONTENTS_TABLE)
        .insert({
          story_id: storyId,
          headline: headline,
          content_full: content,
          content_length: contentLength,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();
      
      if (error) {
        console.error(`데이터베이스 저장 오류:`, error.message, error.details, error.hint);
        return { storyId, method: StorageMethod.NONE };
      }
      
      console.log(`원문을 데이터베이스에 저장했습니다 (${contentLength} 바이트): ${headline} (ID: ${data.id})`);
      
      // 캐시에 저장
      ApiCache.set(cacheKey, {
        storyId,
        id: data.id,
        method: StorageMethod.DATABASE
      });
      
      return { 
        storyId, 
        id: data.id, 
        method: StorageMethod.DATABASE,
        size: contentLength
      };
    }
    
    // 2. 텍스트가 긴 경우 스토리지에 저장
    else {
      const filename = `articles/${storyId}/content.md`;
      
      // 스토리지 디렉토리 생성을 위한 로그
      console.log(`스토리지에 긴 콘텐츠 저장 시작 (${contentLength} 바이트): ${filename}`);
      
      const { data: storageData, error: storageError } = await supabase
        .storage
        .from(STORAGE_BUCKET)
        .upload(filename, new Blob([content], { type: 'text/markdown' }), {
          cacheControl: '3600',
          upsert: true
        });
      
      if (storageError) {
        console.error(`스토리지 저장 오류:`, storageError);
        
        // 스토리지 저장 실패 시 데이터베이스에 저장 시도 (긴 콘텐츠 처리)
        console.log(`스토리지 저장 실패, 데이터베이스에 저장 시도 중...`);
        
        try {
          // 콘텐츠가 너무 길면 앞부분만 저장
          const truncatedContent = content.substring(0, MAX_DB_CONTENT_SIZE - 100) + 
                              "\n\n[콘텐츠가 너무 길어 잘렸습니다. 전체 내용은 원본 링크를 참조하세요.]";
          
          const { data, error } = await supabase
            .from(CONTENTS_TABLE)
            .insert({
              story_id: storyId,
              headline: headline,
              content_full: truncatedContent,
              content_length: truncatedContent.length,
              created_at: new Date().toISOString()
            })
            .select('id')
            .single();
            
          if (error) {
            console.error(`대체 저장 방법도 실패:`, error.message, error.details, error.hint);
            return { storyId, method: StorageMethod.NONE };
          }
          
          console.log(`긴 콘텐츠를 잘라서 데이터베이스에 저장했습니다: ${headline}`);
          return { 
            storyId, 
            id: data.id, 
            method: StorageMethod.DATABASE,
            size: truncatedContent.length
          };
        } catch (finalError) {
          console.error(`모든 저장 방법 실패:`, finalError);
          return { storyId, method: StorageMethod.NONE };
        }
      }
      
      // 메타데이터만 데이터베이스에 저장
      const { data, error } = await supabase
        .from(CONTENTS_TABLE)
        .insert({
          story_id: storyId,
          headline: headline,
          storage_path: storageData.path,
          content_length: contentLength,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();
      
      if (error) {
        console.error(`메타데이터 저장 오류:`, error);
        return { storyId, method: StorageMethod.NONE };
      }
      
      console.log(`원문을 스토리지에 저장했습니다 (${contentLength} 바이트): ${headline}`);
      
      // 캐시에 저장 (경로만)
      ApiCache.set(cacheKey, {
        storyId,
        id: data.id,
        method: StorageMethod.STORAGE,
        path: storageData.path
      });
      
      return { 
        storyId, 
        id: data.id, 
        method: StorageMethod.STORAGE, 
        path: storageData.path,
        size: contentLength
      };
    }
  } catch (error) {
    console.error(`원문 저장 중 오류 발생:`, error);
    return { storyId, method: StorageMethod.NONE };
  }
}

/**
 * 저장된 원문 검색
 * 
 * @param storyId 스토리 ID
 * @returns 원문 내용 또는 null
 */
export async function retrieveFullContent(storyId: string): Promise<string | null> {
  // Supabase가 설정되지 않은 경우
  if (!isSupabaseConfigured) {
    console.log('Supabase가 설정되지 않아 콘텐츠 검색을 건너뜁니다.');
    return null;
  }
  
  // 재시도 설정
  const maxRetries = 2;
  let retryCount = 0;
  
  while (retryCount <= maxRetries) {
    try {
      // storyId가 UUID 형식인지 확인 (테이블의 id로 검색할지, story_id로 검색할지 결정)
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storyId);
      
      console.log(`콘텐츠 검색: ${storyId} (${isUuid ? 'UUID 형식' : '일반 ID 형식'})`);
      
      // 캐시 키 생성
      const cacheKey = `content:${storyId}`;
      
      // 캐시에서 메타데이터 확인
      const cachedResult = ApiCache.get<ContentStorageResult>(cacheKey);
      
      // 먼저 메타데이터 검색
      let contentData: ContentStorageItem | null = null;
      
      if (cachedResult?.id) {
        console.log(`캐시된 ID로 콘텐츠 검색 시도 (ID: ${cachedResult.id})`);
        const { data, error } = await supabase
          .from(CONTENTS_TABLE)
          .select('*')
          .eq('id', cachedResult.id)
          .maybeSingle();
        
        if (error) {
          console.error(`캐시된 ID로 콘텐츠 검색 오류:`, error);
        } else if (data) {
          contentData = data;
          console.log(`캐시된 ID로 콘텐츠를 찾았습니다.`);
        }
      }
      
      // 캐시된 ID로 찾지 못한 경우 스토리 ID로 검색
      if (!contentData) {
        if (isUuid) {
          // UUID 형식이면 테이블의 id 컬럼으로 검색
          console.log(`테이블 id로 콘텐츠 검색 시도 (UUID: ${storyId})`);
          const { data: idData, error: idError } = await supabase
            .from(CONTENTS_TABLE)
            .select('*')
            .eq('id', storyId)
            .maybeSingle();
          
          if (!idError && idData) {
            contentData = idData;
            console.log(`테이블 id로 콘텐츠를 찾았습니다.`);
          } else {
            // id로 찾지 못하면 story_id로도 시도
            console.log(`테이블 id로 찾지 못해 story_id로 검색 시도`);
            const { data: storyIdData, error: storyIdError } = await supabase
              .from(CONTENTS_TABLE)
              .select('*')
              .eq('story_id', storyId)
              .maybeSingle();
              
            if (!storyIdError && storyIdData) {
              contentData = storyIdData;
              console.log(`story_id로 콘텐츠를 찾았습니다.`);
            }
          }
        } else {
          // 일반 형식이면 story_id 컬럼으로 검색
          console.log(`story_id로 콘텐츠 검색 시도 (ID: ${storyId})`);
          const { data: storyData, error: storyError } = await supabase
            .from(CONTENTS_TABLE)
            .select('*')
            .eq('story_id', storyId)
            .maybeSingle();
          
          if (!storyError && storyData) {
            contentData = storyData;
            console.log(`story_id로 콘텐츠를 찾았습니다.`);
          }
        }
        
        // 여전히 찾지 못했으면 테이블에서 최신 레코드 가져오기
        if (!contentData) {
          console.log(`정확한 ID 일치가 없습니다. 최신 콘텐츠 가져오기 시도...`);
          const { data: latestRecord, error: latestError } = await supabase
            .from(CONTENTS_TABLE)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          
          if (!latestError && latestRecord) {
            contentData = latestRecord;
            console.log(`최신 콘텐츠를 찾았습니다. (ID: ${latestRecord.id}, story_id: ${latestRecord.story_id})`);
          } else {
            console.log(`ID: ${storyId}에 해당하는 콘텐츠를 찾을 수 없습니다.`);
            
            // 다음 재시도를 위해 대기
            if (retryCount < maxRetries) {
              const waitTime = Math.pow(2, retryCount) * 1000; // 지수 백오프
              console.log(`재시도 ${retryCount + 1}/${maxRetries}, ${waitTime}ms 후 시도...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              retryCount++;
              continue;
            }
          }
        }
      }
      
      // 데이터베이스에 직접 저장된 경우
      if (contentData && contentData.content_full) {
        console.log(`데이터베이스에서 원문 콘텐츠를 찾았습니다 (${contentData.content_full.length} 바이트)`);
        return contentData.content_full;
      }
      
      // 스토리지에 저장된 경우
      else if (contentData && contentData.storage_path) {
        console.log(`스토리지에서 콘텐츠 다운로드 시도 (경로: ${contentData.storage_path})`);
        const { data: fileData, error: fileError } = await supabase
          .storage
          .from(STORAGE_BUCKET)
          .download(contentData.storage_path);
        
        if (fileError || !fileData) {
          console.error(`스토리지에서 파일 다운로드 실패:`, fileError);
          
          // 스토리지 접근 실패 시 다음 재시도를 위해 대기
          if (retryCount < maxRetries) {
            const waitTime = Math.pow(2, retryCount) * 1000; // 지수 백오프
            console.log(`재시도 ${retryCount + 1}/${maxRetries}, ${waitTime}ms 후 시도...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            retryCount++;
            continue;
          }
          
          return null;
        }
        
        const textContent = await fileData.text();
        console.log(`스토리지에서 콘텐츠를 성공적으로 다운로드했습니다 (${textContent.length} 바이트)`);
        return textContent;
      }
      
      // 콘텐츠를 찾지 못한 경우
      console.log(`ID: ${storyId}에 대한 콘텐츠가 데이터베이스나 스토리지에 존재하지 않습니다.`);
      return null;
      
    } catch (error) {
      console.error(`원문 검색 중 예외 발생:`, error);
      
      // 다음 재시도를 위해 대기
      if (retryCount < maxRetries) {
        const waitTime = Math.pow(2, retryCount) * 1000; // 지수 백오프
        console.log(`재시도 ${retryCount + 1}/${maxRetries}, ${waitTime}ms 후 시도...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retryCount++;
      } else {
        return null;
      }
    }
  }
  
  return null;
} 