import dotenv from "dotenv";

dotenv.config();

export async function getCronSources(): Promise<{ identifier: string }[]> {
  try {
    console.log("Fetching sources...");

    // Check for required API keys
    const hasXApiKey = !!process.env.X_API_BEARER_TOKEN;
    const hasFirecrawlKey = !!process.env.FIRECRAWL_API_KEY;

    // Define sources based on available API keys
    const sources: { identifier: string }[] = [
      // 공식 블로그
      { identifier: "https://deepmind.google/discover/blog/" },
      { identifier: "https://huggingface.co/blog" },
      { identifier: "https://ai.meta.com/blog/" },
      { identifier: "https://openai.com/news/" },
      { identifier: "https://www.anthropic.com/news" },
      { identifier: "https://www.firecrawl.dev/blog" },
      
      // 뉴스
      { identifier: "https://www.wsj.com/technology" },
      { identifier: "https://www.reuters.com/technology/artificial-intelligence/" },
      { identifier: "https://www.bloomberg.com/technology" },

      // 블로그
      { identifier: "https://news.ycombinator.com/" },
      { identifier: "https://simonwillison.net/" },
      { identifier: "https://buttondown.com/ainews/archive/" },

      // 트위터
      ...(hasXApiKey ? [{ identifier: "https://x.com/minchoi" }] : []),
    ];

    // Return the full objects instead of mapping to strings
    return sources;
  } catch (error) {
    console.error(error);
    return [];
  }
}
