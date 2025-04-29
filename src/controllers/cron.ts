import { scrapeSources } from "../services/scrapeSources";
import { getCronSources } from "../services/getCronSources";
import { generateDraft } from "../services/generateDraft";
import { sendDraft } from "../services/sendDraft";
import { ApiCache } from "../utils/apiCache";

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
  } catch (error) {
    console.error("크론 작업 중 오류 발생:", error);
  }
};
