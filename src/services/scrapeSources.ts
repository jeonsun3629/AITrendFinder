import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
// Removed Together import
import { z } from "zod";
// 외부 API 호출 실패로 인해 fetch import 제거
// Removed zodToJsonSchema import since we no longer enforce JSON output via Together
import axios from "axios"; // axios 추가

dotenv.config();

// 환경변수에서 설정값 로드 또는 기본값 사용
const BATCH_SIZE = parseInt(process.env.CRAWL_BATCH_SIZE || '3', 10);
const BATCH_DELAY = parseInt(process.env.CRAWL_BATCH_DELAY || '5000', 10);
const REQUEST_DELAY = parseInt(process.env.CRAWL_ITEM_DELAY || '1000', 10);
const MAX_STORIES_PER_SOURCE = parseInt(process.env.MAX_STORIES_PER_SOURCE || '3', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

// Initialize Firecrawl
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// 1. Define the schema for our expected JSON
const StorySchema = z.object({
  headline: z.string().describe("Story or post headline"),
  link: z.string().describe("A link to the post or story"),
  date_posted: z.string().describe("The date the story or post was published"),
  fullContent: z.string().optional().describe("Full content of the story or post"),
  fullContent_kr: z.string().optional().describe("Korean translation of the full content"),
  imageUrls: z.array(z.string()).optional().describe("Image URLs from the post"),
  videoUrls: z.array(z.string()).optional().describe("Video URLs from the post"),
  popularity: z.string().optional().describe("Popularity metrics like retweets, likes, etc.")
});

// 전체 콘텐츠 추출을 위한 스키마 추가
const ContentSchema = z.object({
  fullContent: z.string().describe("The full content of the article"),
  imageUrls: z.array(z.string()).optional().describe("Image URLs from the article"),
  videoUrls: z.array(z.string()).optional().describe("Video URLs from the article")
});

const StoriesSchema = z.object({
  stories: z
    .array(StorySchema)
    .describe("A list of today's AI or LLM-related stories"),
});

// Define the TypeScript type for a story using the schema
export type Story = z.infer<typeof StorySchema>;

/**
 * 주어진 날짜 문자열이 24시간 이내인지 확인합니다.
 * 상대적 시간 표현(today, hours ago 등)에 더 가중치를 둡니다.
 */
function isLikelyRecent(dateString: string): boolean {
  try {
    // 날짜 문자열이 비어있는 경우
    if (!dateString || dateString.trim() === '') {
      return false;
    }
    
    // 날짜 문자열에서 상대적 시간 표현 확인
    const dateLower = dateString.toLowerCase();
    
    // 최근 시간 키워드 확인 (시간 지표)
    const recentTimeKeywords = [
      'today', 'hours ago', 'minutes ago', 'just now', 'hour ago',
      '시간 전', '분 전', '방금', 'yesterday', 'a day ago', '1 day ago'
    ];
    
    // 키워드 기반 확인
    if (recentTimeKeywords.some(keyword => dateLower.includes(keyword))) {
      console.log(`최근 시간 키워드 발견: ${dateString}`);
      return true;
    }
    
    // 숫자 + 시간 단위 패턴 확인 (단일 정규식으로 통합)
    const timePattern = /(\d+)\s*(hour|minute|day|시간|분|일)\s*(ago|전)?/i;
    const timeMatch = dateLower.match(timePattern);
    
    if (timeMatch) {
      const amount = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      
      // 단위에 따른 시간 확인
      if (unit.includes('hour') || unit.includes('시간') || unit === 'h') {
        // 24시간 이내면 최근
        console.log(`${amount}시간 전으로 확인됨`);
        return amount <= 24;
      }
      
      if (unit.includes('minute') || unit.includes('분') || unit === 'm') {
        // 분 단위는 항상 최근
        console.log(`${amount}분 전으로 확인됨`);
        return true;
      }
      
      if (unit.includes('day') || unit.includes('일') || unit === 'd') {
        // 2일 이내면 최근
        console.log(`${amount}일 전으로 확인됨`);
        return amount <= 2;
      }
    }
    
    // 오래된 내용 지표 확인
    const oldKeywords = [
      'last week', 'last month', 'last year', 
      '지난주', '지난달', '작년', 
      '3 days ago', '4 days ago', '5 days ago'
    ];
    
    if (oldKeywords.some(keyword => dateLower.includes(keyword))) {
      console.log(`오래된 내용 지표 발견: ${dateString}`);
      return false;
    }
    
    // 오늘 날짜와 일치 확인
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    
    if (dateLower.includes(todayStr)) {
      console.log(`오늘 날짜 포함: ${dateString}`);
      return true;
    }
    
    // 날짜 파싱 시도
    try {
      const date = new Date(dateString);
      
      // 유효한 날짜인 경우
      if (!isNaN(date.getTime())) {
        // 현재 시간과의 차이 계산 (밀리초)
        const now = new Date();
        const timeDiff = now.getTime() - date.getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);
        
        // 24시간 이내 확인 - 시간대 차이 고려
        if (hoursDiff <= 24 && hoursDiff >= -24) { // 시간대 차이 고려하여 미래 날짜도 약간 허용
          console.log(`24시간 이내 날짜: ${dateString} (${hoursDiff.toFixed(1)}시간 전)`);
          return true;
        }
      }
    } catch (e) {
      // 날짜 파싱 실패는 무시
    }
    
    // 기본적으로 최근이 아닌 것으로 간주
    return false;
  } catch (e) {
    console.error(`날짜 확인 중 오류: ${e}`);
    return false;
  }
}

/**
 * 요청 전 지연 시간을 추가합니다.
 * @param minDelay 최소 지연 시간 (ms)
 * @param maxDelay 최대 지연 시간 (ms)
 */
async function sleep(minDelay: number = 500, maxDelay: number = 1500): Promise<void> {
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  console.log(`API 요청 제한 방지를 위해 ${Math.round(delay)}ms 대기 중...`);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 재시도 로직이 포함된 API 호출 함수
 */
async function apiCallWithRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  baseDelay: number = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    // 429 오류(너무 많은 요청) 또는 일반 오류 처리
    const isRateLimited = error.status === 429 || 
                          (error.message && error.message.includes('rate limit'));
    
    if (retries <= 0) throw error;
    
    // 속도 제한 오류인 경우 지수 백오프 적용
    const delay = isRateLimited 
      ? Math.pow(2, MAX_RETRIES - retries) * baseDelay + Math.random() * 1000
      : baseDelay;
    
    console.log(`API 오류${isRateLimited ? '(속도 제한)' : ''}, ${delay}ms 후 재시도합니다. 남은 재시도: ${retries}`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return apiCallWithRetry(fn, retries - 1, baseDelay);
  }
}

/**
 * 단일 소스를 스크래핑하는 함수
 */
async function scrapeSource(source: string, now: Date): Promise<Story[]> {
  console.log(`처리 중인 소스: ${source}`);
  
  try {
    // API 속도 제한 방지를 위한 지연
    await sleep(500, REQUEST_DELAY);
    
    // 날짜 형식 준비
    const todayISO = now.toISOString().split('T')[0];
    
    // 구조화된 데이터를 요청하는 프롬프트, 날짜 관련 지시사항 개선
    const promptForStructured = `
      IMPORTANT ABOUT DATES:
      Current time: ${now.toLocaleString()}.
      Today's date: ${todayISO}.
      
      MOST IMPORTANT: Don't rely on exact dates - trust the RELATIVE time indicators on the site:
      - Words like "today", "just now", "minutes ago", "hours ago"
      - Recent dates visible on the page
      - Articles featured in "Latest News", "Recent Posts", or similar sections
      - Content at the TOP of the page
      
      IMPORTANT ABOUT CONTENT SELECTION:
      - Prioritize stories that appear at the TOP of the page first (these are usually most recent)
      - If view count or popularity metrics are visible, prioritize stories with HIGHER view counts or engagement
      - Look for featured, trending, or highlighted stories first
      - Only include the MOST IMPORTANT and RELEVANT AI/LLM stories, maximum 5 per source
      - Look for timestamps, publication dates, or "posted X hours ago" indicators
      
      IMPORTANT ABOUT EXTRACTION:
      - We ONLY want stories published within the LAST 24 HOURS
      - Look for these EXACT time formats and patterns:
        * "today"
        * "X hours ago" (e.g., "9 hours ago", "2 hours ago")
        * "about X hours ago" (e.g., "about 9 hours ago")
        * "X minutes ago"
        * "just now"
        * "1 day ago" or "a day ago" or "yesterday"
      - Copy the EXACT date string as it appears on the page to date_posted field
      - For Huggingface blog, pay special attention to time indicators like "1 day ago", "about 23 hours ago"
      - If you're unsure about the exact time, include the story anyway and provide the time string
      
      IMPORTANT ABOUT CONTENT SELECTION:
      - Prioritize stories that appear at the TOP of the page first (these are usually most recent)
      - If view count or popularity metrics are visible, prioritize stories with HIGHER view counts or engagement
      - Look for featured, trending, or highlighted stories first
      - Only include the MOST IMPORTANT and RELEVANT AI/LLM stories, maximum 5 per source
      - Look for timestamps, publication dates, or "posted X hours ago" indicators
      
      The format should be:
      {
        "stories": [
          {
            "headline": "headline1",
            "link": "link1",
            "date_posted": "Copy the EXACT date/time string from the page. If none, use 'recent'",
            "popularity": "optional popularity indicator if available (view count, likes, etc.)"
          },
          ...
        ]
      }
      
      IMPORTANT: Include ONLY stories published within the LAST 24 HOURS. Look for:
      - Stories with timestamps showing "today", "yesterday", "X hours ago", "X days ago", "just now", "minutes ago"
      - Content at the very TOP of the page with recent indicators
      If you are unsure about the exact publication time, include it anyway and our system will verify it.
      If you find NO clear stories published within the last few days, return empty data.
      
      The source link is ${source}. 
      If a story link is not absolute, prepend ${source} to make it absolute. 
      Return only pure JSON in the specified format.
    `;
    
    // 전체 내용, 이미지, 비디오 추출 프롬프트
    const promptForContent = `
      Extract the COMPLETE and FULL content, image URLs, and video URLs from this page.
      Return as valid JSON with this structure:
      { 
        "fullContent": "the full article content as markdown with ALL paragraphs, sections, and formatting preserved",
        "imageUrls": ["url1", "url2", ...],
        "videoUrls": ["url1", "url2", ...]
      }
      
      VERY IMPORTANT: 
      1. Do NOT truncate, shorten, or summarize the fullContent. 
      2. Preserve ALL paragraphs, line breaks, headers, and formatting of the original content exactly as they appear.
      3. Include the ENTIRE article text, even if it is very long.
      4. For image and video URLs:
         - Convert ALL relative URLs to absolute ones by prepending ${new URL(source).origin} if needed
         - Include Open Graph (og:image) and Twitter card images
         - Include ALL article images, charts, diagrams and figures
         - Include thumbnails for videos
         - Extract embedded video players (YouTube, Vimeo, Twitter videos, etc.)
         - IMPORTANT: ONLY extract images and videos that are part of the MAIN ARTICLE CONTENT
         - DO NOT include profile pictures, logos, icons, navigation images, sidebar widgets, or advertisements
         - Focus on extracting content images like photos, charts, graphs, diagrams, and screenshots
      5. Remove any unnecessary metadata, navigation elements, or footer information from the content.
      6. Make sure to properly escape any special characters in the fullContent.
      7. Media detection:
         - For images: Look for .jpg, .jpeg, .png, .webp, .gif, .svg files
         - For videos: Look for .mp4, .webm, .mov files and embedded players from YouTube, Vimeo, Twitter, etc.
         - Also extract URLs containing 'video', 'player', 'embed', 'media', etc.
         - For YouTube videos, transform watch URLs to embed URLs where possible
         - EXTRACT ALL HTML image tags (<img src="...">) from the article content
         - Also look for background-image CSS properties in the article content
      7. Return only pure JSON in the specified format.
    `;
    
    // 먼저 구조화된 정보 추출
    const scrapeResult = await apiCallWithRetry(async () => {
      return await app.extract([source], {
        prompt: promptForStructured,
        schema: StoriesSchema,
      });
    });
    
    // 디버깅 - 실제 응답 확인
    console.log(`Firecrawl 원본 응답:`, JSON.stringify(scrapeResult).substring(0, 500) + '...');
    
    if (!scrapeResult.success) {
      throw new Error(`Failed to scrape: ${scrapeResult.error}`);
    }
    
    // 추출된 데이터
    const todayStories = scrapeResult.data as { stories: Story[] };
    
    if (!todayStories || !todayStories.stories || todayStories.stories.length === 0) {
      console.log(`${source}에서 최근 스토리를 찾을 수 없습니다.`);
      return [];
    }
    
    // 각 스토리 처리 및 최신성 필터링
    const filteredStories: Story[] = [];
    
    // 스토리 수 제한 (API 속도 제한 방지)
    const limitedStories = todayStories.stories.slice(0, MAX_STORIES_PER_SOURCE);
    
    for (const story of limitedStories) {
      // 최근 24시간 내 콘텐츠인지 확인
      const isRecent = isLikelyRecent(story.date_posted);
          
      if (isRecent) {
        console.log(`최근 스토리 발견: ${story.headline}`);
        filteredStories.push(story);
        
        // 링크가 있는 경우 내용, 이미지, 비디오 추출
        if (story.link) {
          try {
            // API 속도 제한 방지를 위한 지연 (각 요청 사이)
            await sleep(REQUEST_DELAY, REQUEST_DELAY * 2);
            
            console.log(`스토리 내용 추출 시작: ${story.headline} (${story.link})`);
            
            // 재시도 로직 적용 및 스키마 추가
            const contentResult = await apiCallWithRetry(async () => {
              return await app.extract([story.link], {
                prompt: promptForContent,
                schema: ContentSchema
              });
            });
            
            // 디버깅을 위한 로그 추가
            console.log(`내용 추출 상태: ${contentResult.success ? '성공' : '실패'}`);
            
            if (contentResult.success) {
              // 응답 구조 확인을 위한 로그 추가
              console.log(`응답 데이터 형식: ${typeof contentResult.data}`, 
                        typeof contentResult.data === 'object' ? Object.keys(contentResult.data) : 'not object');
              
              // 다양한 응답 구조 처리
              let contentData;
              if (typeof contentResult.data === 'object') {
                contentData = contentResult.data;
              } else if (typeof contentResult.data === 'string') {
                try {
                  contentData = JSON.parse(contentResult.data);
                } catch (e) {
                  contentData = { fullContent: contentResult.data };
                }
              }
              
              // 내용 추출
              if (contentData) {
                story.fullContent = contentData.fullContent || '';
                story.imageUrls = contentData.imageUrls || [];
                story.videoUrls = contentData.videoUrls || [];
                
                // 내용이 추출되었는지 확인 로그
                const contentPreview = story.fullContent ? story.fullContent.substring(0, 100) : '';
                console.log(`내용 추출 결과: ${contentPreview.length > 0 ? '성공' : '실패'} (미리보기: ${contentPreview}...)`);
                console.log(`이미지 URL 개수: ${story.imageUrls?.length || 0}, 비디오 URL 개수: ${story.videoUrls?.length || 0}`);
              } else {
                console.log(`내용 데이터 없음: ${story.headline}`);
              }
            } else {
              console.error(`내용 추출 실패 (${story.link}): ${contentResult.error || '알 수 없는 오류'}`);
            }
          } catch (contentError) {
            console.error(`내용 추출 중 오류 (${story.link}):`, contentError);
            // 429 오류 발생 시 기본 정보만 사용
            story.fullContent = `[원본 내용을 가져올 수 없습니다 - API 속도 제한. 자세한 내용은 원본 링크를 참조하세요]`;
            story.imageUrls = [];
            story.videoUrls = [];
          }
          
          // 내용이 없으면 헤드라인을 내용으로 사용
          if (!story.fullContent || story.fullContent.trim() === '') {
            console.log(`내용 없음, 헤드라인을 내용으로 사용: ${story.headline}`);
            story.fullContent = story.headline;
          }
        }
      } else {
        console.log(`오래된 스토리 제외: ${story.headline} - ${story.date_posted}`);
      }
    }
    
    console.log(`${source}에서 ${filteredStories.length}개의 최근 스토리를 찾았습니다.`);
    return filteredStories;
  } catch (error) {
    console.error(`Error scraping ${source}:`, error);
    return [];
  }
}

/**
 * Scrape sources using Firecrawl and returns a combined array of story objects.
 * Uses parallel processing to improve performance.
 */
export async function scrapeSources(
  sources: { identifier: string }[],
): Promise<Story[]> {
  // 시스템 시간 사용
  const now = new Date();
  
  console.log(`총 ${sources.length}개의 소스를 처리합니다.`);
  console.log(`시스템 시간: ${now.toISOString()}`);
  console.log(`[중요] 상대적 시간 표현(오늘, 몇 시간 전 등)을 중심으로 최근 24시간 내 게시물을 식별합니다.`);

  try {
    // 소스를 소규모 배치로 나누어 처리 (API 속도 제한 방지)
    const allStories: Story[] = [];
    
    for (let i = 0; i < sources.length; i += BATCH_SIZE) {
      const batch = sources.slice(i, i + BATCH_SIZE);
      console.log(`소스 배치 ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(sources.length/BATCH_SIZE)} 처리 중 (${batch.length}개)...`);
      
      // 각 배치를 순차적으로 처리하여 과부하 방지
      for (const sourceObj of batch) {
        const sourceStories = await scrapeSource(sourceObj.identifier, now);
        allStories.push(...sourceStories);
        
        // 소스 간에 지연 추가
        if (sourceObj !== batch[batch.length - 1]) {
          await sleep(REQUEST_DELAY, REQUEST_DELAY * 1.5);
        }
      }
      
      // 배치 사이에 지연 추가
      if (i + BATCH_SIZE < sources.length) {
        console.log(`다음 배치 전 ${BATCH_DELAY/1000}초 대기...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }
    
    console.log(`모든 소스에서 총 ${allStories.length}개의 스토리를 찾았습니다.`);
    return allStories;
  } catch (error) {
    console.error("Error in scrapeSources:", error);
    return [];
  }
}
