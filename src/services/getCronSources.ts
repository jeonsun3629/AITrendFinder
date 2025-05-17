import dotenv from "dotenv";

dotenv.config();

export async function getCronSources(): Promise<{ identifier: string }[]> {
  try {
    console.log("Fetching sources...");

    // Check for required API keys
    const hasXApiKey = !!process.env.X_API_BEARER_TOKEN;
    const hasFirecrawlKey = !!process.env.FIRECRAWL_API_KEY;

    // 간단한 테스트를 위해 잘 구조화된 블로그 하나만 사용
    const sources: { identifier: string }[] = [
      // 가장 크롤링하기 쉬운 블로그 하나만 선택
      // { identifier: "https://deepmind.google/discover/blog/" },
      { identifier: "https://huggingface.co/blog/community" },
      // { identifier: "https://ai.meta.com/blog/" },
      // { identifier: "https://openai.com/news/" },
      // { identifier: "https://www.anthropic.com/news" },

      // // // // 뉴스
      // { identifier: "https://www.reuters.com/technology/artificial-intelligence/" },

      // // 블로그
      { identifier: "https://news.ycombinator.com/" },
      // { identifier: "https://simonwillison.net/" },
      // { identifier: "https://buttondown.com/ainews/archive/" },
    ];

    console.log(`테스트용 단일 소스 사용: ${sources[0].identifier}`);
    return sources;
  } catch (error) {
    console.error(error);
    return [];
  }
}
