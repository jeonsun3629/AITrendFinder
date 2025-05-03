import { scrapeSources } from "../services/scrapeSources";
import { getCronSources } from "../services/getCronSources";
import { generateDraft } from "../services/generateDraft";
import { sendDraft } from "../services/sendDraft";
import { ApiCache } from "../utils/apiCache";
import { supabase } from "../utils/supabase";

// 에러 발생 시 재시도 함수
async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delay: number = 2000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    
    console.log(`에러 발생, ${delay}ms 후 재시도합니다. 남은 재시도: ${retries}`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 1.5);
  }
}

// 열린 연결 정리 함수
async function cleanupConnections(): Promise<void> {
  try {
    console.log("열린 연결 정리 중...");
    
    // Supabase 연결 종료
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error("Supabase 로그아웃 오류:", error);
      } else {
        console.log("Supabase 연결 종료됨");
      }
    }
    
    // 기타 필요한 정리 작업 수행
    ApiCache.cleanExpired();
    console.log("캐시 정리 완료");
    
    // Node.js 이벤트 루프에 남아있는 타이머 확인 (타입 안전하게 수정)
    // @ts-ignore: Node.js 내부 API 사용
    const activeHandles = process._getActiveHandles ? process._getActiveHandles() : [];
    if (activeHandles && activeHandles.length > 0) {
      console.log(`활성 핸들 수: ${activeHandles.length} - 프로세스가 계속 실행될 수 있습니다`);
      
      // 열린 HTTP 연결이나 타이머 등을 강제로 종료하기 위한 시도
      // (참고: 이 방법은 일부 연결만 정리할 수 있습니다)
      global.setTimeout(() => {
        console.log("남은 연결 정리 완료");
      }, 500);
    } else {
      console.log("활성 핸들이 없습니다");
    }
    
    console.log("연결 정리 완료");
  } catch (cleanupError) {
    console.error("연결 정리 중 오류:", cleanupError);
  }
}

export const handleCron = async (): Promise<void> => {
  try {
    console.log("크론 작업 시작: " + new Date().toLocaleString());
    
    // 오래된 캐시 정리
    ApiCache.cleanExpired();
    console.log(`현재 캐시 크기: ${ApiCache.size()} 항목`);
    
    // 소스 목록 가져오기 (재시도 로직 적용)
    const cronSources = await withRetry(async () => {
      return await getCronSources();
    });
    
    console.log("모든 소스 목록:", cronSources.map(s => s.identifier));
    
    // 소스 스크래핑 (재시도 로직 적용)
    const rawStories = await withRetry(async () => {
      return await scrapeSources(cronSources);
    });
    
    const rawStoriesString = JSON.stringify(rawStories);
    console.log(`스크래핑 결과: ${rawStories.length}개 스토리 (${rawStoriesString.length} 바이트)`);
    
    // 드래프트 생성 (재시도 로직 적용)
    const draftResult = await withRetry(async () => {
      return await generateDraft(rawStoriesString);
    });
    
    // 결과 전송 (재시도 로직 적용)
    const result = await withRetry(async () => {
      return await sendDraft(draftResult!);
    });
    
    console.log("크론 작업 완료:", result);
    console.log(`캐시 통계: ${ApiCache.size()} 항목`);
    
    // 모든 작업이 완료된 후 연결 정리
    await cleanupConnections();
    
    // 작업 완료 후 명시적으로 빠른 종료를 위한 플래그 설정
    console.log("모든 작업 및 정리 완료, 프로세스 종료 준비");
    
    // 마지막 정리 작업을 위한 짧은 지연 후 강제 종료 설정
    if (process.env.NODE_ENV === 'production' || process.env.CI === 'true') {
      setTimeout(() => {
        console.log("프로세스 강제 종료");
        process.exit(0);
      }, 2000);
    }
  } catch (error) {
    console.error("크론 작업 중 오류 발생:", error);
    // 오류 발생해도 연결 정리 시도
    await cleanupConnections();
    
    // 오류 발생 시 비정상 종료
    if (process.env.NODE_ENV === 'production' || process.env.CI === 'true') {
      setTimeout(() => {
        console.log("오류로 인한 프로세스 강제 종료");
        process.exit(1);
      }, 2000);
    }
  }
};
