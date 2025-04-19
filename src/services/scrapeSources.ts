import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
// Removed Together import
import { z } from "zod";
// Removed zodToJsonSchema import since we no longer enforce JSON output via Together

dotenv.config();

// Initialize Firecrawl
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// 1. Define the schema for our expected JSON
const StorySchema = z.object({
  headline: z.string().describe("Story or post headline"),
  link: z.string().describe("A link to the post or story"),
  date_posted: z.string().describe("The date the story or post was published"),
  fullContent: z.string().optional().describe("Full content of the story or post"),
  imageUrls: z.array(z.string()).optional().describe("Image URLs from the post"),
  videoUrls: z.array(z.string()).optional().describe("Video URLs from the post")
});

const StoriesSchema = z.object({
  stories: z
    .array(StorySchema)
    .describe("A list of today's AI or LLM-related stories"),
});

// Define the TypeScript type for a story using the schema
type Story = z.infer<typeof StorySchema>;

/**
 * Scrape sources using Firecrawl (for non-Twitter URLs) and the Twitter API.
 * Returns a combined array of story objects.
 */
export async function scrapeSources(
  sources: { identifier: string }[],
): Promise<Story[]> {
  // Explicitly type the stories array so it is Story[]
  const combinedText: { stories: Story[] } = { stories: [] };

  // Configure toggles for scrapers
  const useScrape = true;
  const useTwitter = true;
  const tweetStartTime = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  ).toISOString();
  
  console.log(`총 ${sources.length}개의 소스를 처리합니다.`);

  for (const sourceObj of sources) {
    const source = sourceObj.identifier;
    console.log(`처리 중인 소스: ${source}`);

    // --- 1) Handle Twitter/X sources ---
    if (source.includes("x.com")) {
      console.log(`X/트위터 소스 감지: ${source}`);
      if (useTwitter) {
        const usernameMatch = source.match(/x\.com\/([^\/]+)/);
        if (!usernameMatch) continue;
        const username = usernameMatch[1];

        // Construct the query and API URL
        const query = `from:${username} has:media -is:retweet -is:reply`;
        const encodedQuery = encodeURIComponent(query);
        const encodedStartTime = encodeURIComponent(tweetStartTime);
        // 이미지, 미디어, 임베디드 URL 등을 포함한 확장된 트윗 정보를 요청
        const apiUrl = `https://api.x.com/2/tweets/search/recent?query=${encodedQuery}&max_results=10&start_time=${encodedStartTime}&expansions=attachments.media_keys&media.fields=url,preview_image_url,type`;

        try {
          console.log(`X API 호출 중: ${username}`);
          const response = await fetch(apiUrl, {
            headers: {
              Authorization: `Bearer ${process.env.X_API_BEARER_TOKEN}`,
            },
          });
          if (!response.ok) {
            throw new Error(
              `Failed to fetch tweets for ${username}: ${response.statusText}`,
            );
          }
          const tweets = await response.json();

          if (tweets.meta?.result_count === 0) {
            console.log(`No tweets found for username ${username}.`);
          } else if (Array.isArray(tweets.data)) {
            console.log(`Tweets found from username ${username}`);
            const stories = tweets.data.map(
              (tweet: any): Story => {
                // 트윗 미디어 처리
                let imageUrls: string[] = [];
                let videoUrls: string[] = [];
                
                // 트윗에 미디어가 포함되어 있는지 확인
                if (tweet.attachments?.media_keys && tweets.includes?.media) {
                  const mediaItems = tweets.includes.media;
                  
                  // 트윗의 미디어 키를 사용하여 관련 미디어 찾기
                  for (const mediaKey of tweet.attachments.media_keys) {
                    const media = mediaItems.find((m: any) => m.media_key === mediaKey);
                    if (media) {
                      // 미디어 타입에 따라 URL 추가
                      if (media.type === 'photo' && media.url) {
                        imageUrls.push(media.url);
                      } else if (media.type === 'video' && (media.url || media.preview_image_url)) {
                        // 비디오는 미리보기 이미지 URL이나 실제 URL 중 사용 가능한 것을 넣음
                        videoUrls.push(media.url || media.preview_image_url);
                      }
                    }
                  }
                }
                
                // URLs in the tweet text
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                const urlMatches = tweet.text.match(urlRegex);
                if (urlMatches) {
                  for (const url of urlMatches) {
                    // 이미지나 비디오 URL로 보이는 것들 분류
                    if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
                      imageUrls.push(url);
                    } else if (url.match(/\.(mp4|webm|mov|avi)(\?.*)?$/i) || url.includes('youtube.com') || url.includes('youtu.be')) {
                      videoUrls.push(url);
                    }
                  }
                }
                
                return {
                  headline: tweet.text,
                  link: `https://x.com/i/status/${tweet.id}`,
                  date_posted: tweetStartTime,
                  fullContent: tweet.text, // 트윗 전체 내용
                  imageUrls: imageUrls,
                  videoUrls: videoUrls
                };
              }
            );
            combinedText.stories.push(...stories);
          } else {
            console.error("Expected tweets.data to be an array:", tweets.data);
          }
        } catch (error: any) {
          console.error(`Error fetching tweets for ${username}:`, error);
        }
      }
    }
    // --- 2) Handle all other sources with Firecrawl ---
    else {
      if (useScrape) {
        const currentDate = new Date().toLocaleDateString();
        try {
          // 구조화된 데이터를 요청하는 프롬프트
          const promptForStructured = `
            Return only today's AI or LLM related story or post headlines and links in JSON format from the page content. 
            They must be posted today, ${currentDate}. The format should be:
            {
              "stories": [
                {
                  "headline": "headline1",
                  "link": "link1",
                  "date_posted": "YYYY-MM-DD"
                },
                ...
              ]
            }
            If there are no AI or LLM stories from today, return {"stories": []}.

            The source link is ${source}. 
            If a story link is not absolute, prepend ${source} to make it absolute. 
            Return only pure JSON in the specified format.
          `;
          
          // 전체 내용, 이미지, 비디오 추출 프롬프트
          const promptForContent = `
            Extract the full content, image URLs, and video URLs from this page.
            Return in JSON format as:
            {
              "fullContent": "the full article content as markdown",
              "imageUrls": ["url1", "url2", ...],
              "videoUrls": ["url1", "url2", ...]
            }
            For image and video URLs, convert relative URLs to absolute ones by prepending ${new URL(source).origin} if needed.
          `;
          
          // 먼저 구조화된 정보 추출
          const scrapeResult = await app.extract([source], {
            prompt: promptForStructured,
            schema: StoriesSchema,
          });
          
          if (!scrapeResult.success) {
            throw new Error(`Failed to scrape: ${scrapeResult.error}`);
          }
          
          // 추출된 데이터
          const todayStories = scrapeResult.data as { stories: Story[] };
          
          if (!todayStories || !todayStories.stories || todayStories.stories.length === 0) {
            console.log(`Found 0 stories from ${source}`);
            continue;
          }
          
          console.log(`Found ${todayStories.stories.length} stories from ${source}`);
          
          // 각 기사에 대해 전체 내용과 미디어 URL 추출 시도
          for (const story of todayStories.stories) {
            try {
              // 기사 링크에서 전체 내용과 미디어 추출
              const contentResult = await app.extract([story.link], {
                prompt: promptForContent,
              });
              
              if (contentResult.success && contentResult.data) {
                const contentData = contentResult.data as any;
                // 추출된 전체 내용과 미디어 URL 설정
                story.fullContent = contentData.fullContent || "";
                story.imageUrls = contentData.imageUrls || [];
                story.videoUrls = contentData.videoUrls || [];
              }
            } catch (contentError) {
              console.error(`Error extracting content for ${story.link}:`, contentError);
              // 오류 발생 시 기본값 설정
              story.fullContent = "";
              story.imageUrls = [];
              story.videoUrls = [];
            }
          }
          
          // 스토리 추가
          combinedText.stories.push(...todayStories.stories);
        } catch (error: any) {
          if (error.statusCode === 429) {
            console.error(
              `Rate limit exceeded for ${source}. Skipping this source.`,
            );
          } else {
            console.error(`Error scraping source ${source}:`, error);
          }
        }
      }
    }
  }

  console.log("Combined Stories:", combinedText.stories);
  return combinedText.stories;
}
