import dotenv from "dotenv";

dotenv.config();

export async function getCronSources(): Promise<{ identifier: string; maxItems?: number; timeframeHours?: number }[]> {
  try {
    console.log("Fetching sources...");

    // Check for required API keys
    const hasXApiKey = !!process.env.X_API_BEARER_TOKEN;
    const hasFirecrawlKey = !!process.env.FIRECRAWL_API_KEY;

    // 각 소스별로 최신 기사 1개만 가져오기 위한 설정
    // maxItems: 각 소스에서 가져올 최대 아이템 수 (1개로 제한)
    // timeframeHours: 현재 시간으로부터 몇 시간 내의 컨텐츠만 가져올지 설정 (48시간)

    const sources: { identifier: string; maxItems: number; timeframeHours: number }[] = [

      // 뉴스
      { identifier: "https://deepmind.google/discover/blog/", maxItems: 1, timeframeHours: 48 },
      { identifier: "https://www.mindstream.news/archive", maxItems: 1, timeframeHours: 48 },
      { identifier: "https://aichief.com/news/", maxItems: 2, timeframeHours: 48 },
      { identifier: "https://news.ycombinator.com/", maxItems: 3, timeframeHours: 48 },

    ];

    // 소스 설정값 확인 및 강화
    const verifiedSources = sources.map(source => {
      return {
        ...source,
        maxItems: source.maxItems || 2, // 전달된 maxItems가 없으면 1로 설정
        timeframeHours: source.timeframeHours || 48 // 전달된 timeframeHours가 없으면 48으로 설정 (기본값)
      };
    });

    console.log(`최근 48시간 내 각 소스별 최신 컨텐츠 1개씩만 가져오도록 설정됨`);
    
    // 최종 소스 목록과 설정 로깅
    verifiedSources.forEach(source => {
      console.log(`소스: ${source.identifier}, 최대 항목: ${source.maxItems}개, 시간 제한: ${source.timeframeHours}시간`);
    });
    
    return verifiedSources;
  } catch (error) {
    console.error(error);
    return [];
  }
}
