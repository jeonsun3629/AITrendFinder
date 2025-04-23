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
  
  // 날짜 형식 개선: 오늘과 어제의 날짜를 여러 형식으로 준비
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  
  // ISO 형식 날짜 (YYYY-MM-DD)
  const todayISO = now.toISOString().split('T')[0];
  const yesterdayISO = yesterday.toISOString().split('T')[0];
  
  // 로케일 형식 날짜
  const todayLocal = now.toLocaleDateString();
  const yesterdayLocal = yesterday.toLocaleDateString();
  
  // 월/일 형식 (MM/DD 또는 DD/MM)
  const todayMonthDay = `${now.getMonth() + 1}/${now.getDate()}`;
  const todayDayMonth = `${now.getDate()}/${now.getMonth() + 1}`;
  
  // 시간 범위 설정 (24시간)
  const tweetStartTime = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  ).toISOString();
  
  console.log(`총 ${sources.length}개의 소스를 처리합니다.`);
  console.log(`오늘 날짜: ${todayISO} (${todayLocal})`);

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
        const apiUrl = `https://api.x.com/2/tweets/search/recent?query=${encodedQuery}&max_results=3&start_time=${encodedStartTime}&expansions=attachments.media_keys&media.fields=url,preview_image_url,type&sort_order=relevancy`;

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
        try {
          // 구조화된 데이터를 요청하는 프롬프트, 날짜 관련 지시사항 개선
          const promptForStructured = `
            Return only today's AI or LLM related story or post headlines and links in JSON format from the page content.
            
            IMPORTANT ABOUT DATES:
            Today is ${todayISO} (${todayLocal}).
            
            Check for posts with these date formats:
            - ISO format: ${todayISO}
            - Local format: ${todayLocal}
            - Month/Day: ${todayMonthDay}, ${todayDayMonth}
            - Text indicators like "today", "hours ago", "minutes ago", "just now"
            
            ONLY include stories from the LAST 24 HOURS. No older content.
            
            IMPORTANT ABOUT CONTENT SELECTION:
            - Prioritize stories that appear at the TOP of the page first
            - If view count or popularity metrics are visible, prioritize stories with HIGHER view counts or engagement
            - Look for featured, trending, or highlighted stories first
            - Only include the MOST IMPORTANT and RELEVANT AI/LLM stories, maximum 5 per source
            
            The format should be:
            {
              "stories": [
                {
                  "headline": "headline1",
                  "link": "link1",
                  "date_posted": "YYYY-MM-DD or exact date string from the page",
                  "popularity": "optional popularity indicator if available (view count, likes, etc.)"
                },
                ...
              ]
            }
            
            If you're uncertain about the exact date, include the post and note the date format in date_posted.
            If there are no recent AI or LLM stories, return {"stories": []}.

            The source link is ${source}. 
            If a story link is not absolute, prepend ${source} to make it absolute. 
            Return only pure JSON in the specified format.
          `;
          
          // 전체 내용, 이미지, 비디오 추출 프롬프트
          const promptForContent = `
            Extract the COMPLETE and FULL content, image URLs, and video URLs from this page.
            Return in JSON format as:
            {
              "fullContent": "the full article content as markdown with ALL paragraphs, sections, and formatting preserved",
              "imageUrls": ["url1", "url2", ...],
              "videoUrls": ["url1", "url2", ...]
            }
            
            VERY IMPORTANT: 
            1. Do NOT truncate, shorten, or summarize the fullContent. 
            2. Preserve ALL paragraphs, line breaks, headers, and formatting of the original content exactly as they appear.
            3. Include the ENTIRE article text, even if it is very long.
            4. For image and video URLs, convert relative URLs to absolute ones by prepending ${new URL(source).origin} if needed.
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
          
          // 날짜 검증 로직 추가
          const validatedStories = todayStories.stories.filter(story => {
            // 날짜 문자열이 비어있으면 포함
            if (!story.date_posted || story.date_posted.trim() === '') {
              console.log(`Story accepted (no date): ${story.headline.substring(0, 50)}...`);
              return true;
            }
            
            // "today", "hours ago", "minutes ago", "just now" 등의 표현 확인
            const dateLower = story.date_posted.toLowerCase();
            if (dateLower.includes('today') || 
                dateLower.includes('hours ago') || 
                dateLower.includes('minutes ago') ||
                dateLower.includes('just now') ||
                dateLower.includes('시간 전') ||
                dateLower.includes('분 전') ||
                dateLower.includes('방금')) {
              console.log(`Story accepted (recent indicator): ${story.headline.substring(0, 50)}...`);
              return true;
            }
            
            // ISO 날짜, 로컬 날짜 형식 확인
            if (dateLower.includes(todayISO) || 
                dateLower.includes(todayLocal) ||
                dateLower.includes(todayMonthDay) ||
                dateLower.includes(todayDayMonth)) {
              console.log(`Story accepted (date match): ${story.headline.substring(0, 50)}...`);
              return true;
            }
            
            // 날짜를 파싱하여 24시간 이내인지 확인 시도
            try {
              const storyDate = new Date(story.date_posted);
              const timeDiff = now.getTime() - storyDate.getTime();
              const hoursDiff = timeDiff / (1000 * 60 * 60);
              
              if (!isNaN(hoursDiff) && hoursDiff <= 24) {
                console.log(`Story accepted (within 24 hours): ${story.headline.substring(0, 50)}...`);
                return true;
              }
            } catch (e) {
              // 날짜 파싱 실패, 다른 방법으로 검증 시도
            }
            
            console.log(`Story rejected (old): ${story.headline.substring(0, 50)}...`);
            return false;
          });
          
          console.log(`Validated ${validatedStories.length} of ${todayStories.stories.length} stories from ${source}`);
          
          // 스토리 개수 제한
          if (validatedStories.length > 5) {
            console.log(`${source}에서 검증된 스토리가 5개 이상입니다. 상위 5개만 사용합니다.`);
            validatedStories.splice(5);
          }
          
          // 각 기사에 대해 전체 내용과 미디어 URL 추출 시도
          for (const story of validatedStories) {
            try {
              // URL 정규화 - 잘못된 URL 형식 수정
              let storyUrl = story.link;
              
              // URL 유효성 검증 및 수정
              try {
                // URL에 쿼리 파라미터와 경로가 섞인 경우 처리
                // 예: http://huggingface.co/blog/community?sort=recent/INSAIT-Institute/mamaylm
                if (storyUrl.includes('?') && storyUrl.includes('/', storyUrl.indexOf('?'))) {
                  const urlParts = storyUrl.split('?');
                  const baseUrl = urlParts[0];
                  const queryPart = urlParts[1];
                  
                  // 쿼리 부분에 '/' 이후 콘텐츠가 있는지 확인
                  if (queryPart.includes('/')) {
                    const queryParams = queryPart.split('/')[0]; // sort=recent 부분
                    storyUrl = `${baseUrl}?${queryParams}`;
                    console.log(`URL 형식 수정됨: ${story.link} -> ${storyUrl}`);
                  }
                }
                
                // URL이 유효한지 확인
                new URL(storyUrl);
              } catch (urlError) {
                console.error(`Invalid URL: ${storyUrl}. Skipping content extraction.`);
                continue;
              }
              
              // 각 URL에 대한 여러 번의 시도 설정 (최대 3번)
              let attempts = 0;
              const maxAttempts = 3;
              let contentData = null;
              
              while (attempts < maxAttempts && !contentData) {
                attempts++;
                try {
                  // 기사 링크에서 전체 내용과 미디어 추출
                  console.log(`Extracting content from ${storyUrl} (attempt ${attempts})`);
                  
                  // 스크랩 전에 URL이 유효한지 확인
                  try {
                    const response = await fetch(storyUrl, { method: 'HEAD' });
                    if (!response.ok) {
                      throw new Error(`URL returned status ${response.status}`);
                    }
                  } catch (error) {
                    console.error(`URL fetch check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    throw error;
                  }
                  
                  const contentResult = await app.extract([storyUrl], {
                    prompt: promptForContent,
                  });
                  
                  if (contentResult.success && contentResult.data) {
                    contentData = contentResult.data as any;
                    // 로그에 콘텐츠 길이 표시
                    if (contentData.fullContent) {
                      console.log(`Successfully extracted content: ${contentData.fullContent.length} characters`);
                      
                      // 콘텐츠가 오류 메시지를 포함하는지 확인
                      if (contentData.fullContent.includes('400') && 
                          contentData.fullContent.includes('Bad Request')) {
                        console.error(`Content contains error message. Cleaning...`);
                        contentData.fullContent = "";
                      }
                    }
                  }
                } catch (attemptError) {
                  console.error(`Attempt ${attempts} failed for ${storyUrl}:`, attemptError);
                  if (attempts >= maxAttempts) throw attemptError;
                  // 다음 시도 전에 잠시 대기
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              }
              
              // 추출된 전체 내용과 미디어 URL 설정
              if (contentData) {
                // 콘텐츠 유효성 검사
                if (contentData.fullContent && 
                    !contentData.fullContent.includes('400') && 
                    !contentData.fullContent.includes('Bad Request')) {
                  story.fullContent = contentData.fullContent;
                } else {
                  console.log(`Invalid content detected, setting empty content`);
                  story.fullContent = "";
                }
                
                // 이미지 및 비디오 URL 설정
                story.imageUrls = Array.isArray(contentData.imageUrls) ? contentData.imageUrls : [];
                story.videoUrls = Array.isArray(contentData.videoUrls) ? contentData.videoUrls : [];
                
                // URL 수정 사항 저장
                if (storyUrl !== story.link) {
                  console.log(`Updating story link from ${story.link} to ${storyUrl}`);
                  story.link = storyUrl;
                }
              } else {
                console.error(`Failed to extract content after ${maxAttempts} attempts for ${storyUrl}`);
                story.fullContent = "";
                story.imageUrls = [];
                story.videoUrls = [];
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
          combinedText.stories.push(...validatedStories);
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
