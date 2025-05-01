import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
import { z } from "zod";
import axios from "axios";
import { storeFullContent } from './contentStorage';
import crypto from 'crypto';

dotenv.config();

// 설정 상수
const CONFIG = {
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v1",
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || "",
  BATCH_SIZE: parseInt(process.env.CRAWL_BATCH_SIZE || '3', 10),
  BATCH_DELAY: parseInt(process.env.CRAWL_BATCH_DELAY || '5000', 10),
  REQUEST_DELAY: parseInt(process.env.CRAWL_ITEM_DELAY || '1000', 10),
  MAX_STORIES_PER_SOURCE: parseInt(process.env.MAX_STORIES_PER_SOURCE || '3', 10),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10)
};

// FirecrawlApp 인스턴스 생성
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// 블로그 사이트 설정 인터페이스
interface BlogSiteConfig {
  contentSelector?: string;
  excludeTags?: string[];
  waitFor?: number;
}

// 블로그 설정 가져오기
function getBlogConfig(domain: string): BlogSiteConfig | null {
  const configs: Record<string, BlogSiteConfig> = {
    'huggingface.co': {
      waitFor: 5000,
      excludeTags: ['nav', 'footer', 'header']
    },
    'openai.com': {
      waitFor: 3000,
      excludeTags: ['nav', 'footer', 'header', 'aside']
    },
    'ai.meta.com': {
      waitFor: 3000,
      excludeTags: ['nav', 'footer']
    },
    'stability.ai': {
      waitFor: 3000
    }
  };

  // 도메인 일치 검사
  for (const configDomain in configs) {
    if (domain.includes(configDomain)) {
      return configs[configDomain];
    }
  }

  return null;
}

// API 호출 유틸리티 함수
async function apiCallWithRetry<T>(fn: () => Promise<T>, retries = CONFIG.MAX_RETRIES): Promise<T> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`API 호출 실패 (재시도 ${i + 1}/${retries}):`, lastError.message);
      
      // 마지막 시도가 아니면 대기 후 재시도
      if (i < retries - 1) {
        const waitTime = Math.pow(2, i) * 1000; // 지수 백오프
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError || new Error('최대 재시도 횟수 초과');
}

// 지연 함수
async function sleep(minMs: number, maxMs?: number): Promise<void> {
  const delay = maxMs ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs : minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// 이미지 URL 추출 함수
function extractImageUrls(html: string): string[] {
  const imageUrls: string[] = [];
  
  // 이미지 태그에서 src 추출
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  
  while ((match = imgRegex.exec(html))) {
    if (match[1] && !match[1].includes('data:image')) {
      imageUrls.push(match[1]);
    }
  }
  
  // 배경 이미지 URL 추출
  const bgRegex = /background-image\s*:\s*url\s*\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  
  while ((match = bgRegex.exec(html))) {
    if (match[1] && !match[1].includes('data:image')) {
      imageUrls.push(match[1]);
    }
  }
  
  return [...new Set(imageUrls)]; // 중복 제거
}

// 비디오 URL 추출 함수
function extractVideoUrls(html: string): string[] {
  const videoUrls: string[] = [];
  
  // 비디오 태그에서 src 추출
  const videoRegex = /<video[^>]+src="([^">]+)"/g;
  let match;
  
  while ((match = videoRegex.exec(html))) {
    if (match[1]) {
      videoUrls.push(match[1]);
    }
  }
  
  // iframe에서 YouTube, Vimeo 등 추출
  const iframeRegex = /<iframe[^>]+src="([^">]+)"/g;
  
  while ((match = iframeRegex.exec(html))) {
    if (match[1] && (match[1].includes('youtube') || match[1].includes('vimeo'))) {
      videoUrls.push(match[1]);
    }
  }
  
  return [...new Set(videoUrls)]; // 중복 제거
}

// Zod 스키마 정의
const StorySchema = z.object({
  headline: z.string().describe("Story or post headline"),
  link: z.string().describe("A link to the post or story"),
  date_posted: z.string().describe("The date the story or post was published"),
  fullContent: z.string().optional().describe("Full content of the story or post"),
  fullContent_kr: z.string().optional().describe("Korean translation of the full content"),
  imageUrls: z.array(z.string()).optional().describe("Image URLs from the post"),
  videoUrls: z.array(z.string()).optional().describe("Video URLs from the post"),
  popularity: z.string().optional().describe("Popularity metrics like retweets, likes, etc."),
  content_storage_id: z.string().optional().describe("ID of the stored content in the database"),
  content_storage_method: z.string().optional().describe("Method used to store the content")
});

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

export type Story = z.infer<typeof StorySchema>;

interface ContentData {
  fullContent: string;
  imageUrls: string[];
  videoUrls: string[];
}

function isLikelyRecent(dateString: string): boolean {
  if (!dateString || dateString.trim() === '') {
    return false;
  }
  
  const dateLower = dateString.toLowerCase();
  
  const recentTimeKeywords = [
    'today', 'hours ago', 'minutes ago', 'just now', 'hour ago',
    '시간 전', '분 전', '방금', 'yesterday', 'a day ago', '1 day ago'
  ];
  
  if (recentTimeKeywords.some(keyword => dateLower.includes(keyword))) {
    return true;
  }
  
  const timePattern = /(\d+)\s*(hour|minute|day|시간|분|일)\s*(ago|전)?/i;
  const timeMatch = dateLower.match(timePattern);
  
  if (timeMatch) {
    const amount = parseInt(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    
    if (unit.includes('hour') || unit.includes('시간') || unit === 'h') {
      return amount <= 24;
    }
    
    if (unit.includes('minute') || unit.includes('분') || unit === 'm') {
      return true;
    }
    
    if (unit.includes('day') || unit.includes('일') || unit === 'd') {
      return amount <= 2;
    }
  }
  
  const oldKeywords = [
    'last week', 'last month', 'last year', 
    '지난주', '지난달', '작년', 
    '3 days ago', '4 days ago', '5 days ago'
  ];
  
  if (oldKeywords.some(keyword => dateLower.includes(keyword))) {
    return false;
  }
  
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  
  if (dateLower.includes(todayStr)) {
    return true;
  }
  
  try {
    const date = new Date(dateString);
    
    if (!isNaN(date.getTime())) {
      const now = new Date();
      const timeDiff = now.getTime() - date.getTime();
      const hoursDiff = timeDiff / (1000 * 60 * 60);
      
      if (hoursDiff <= 24 && hoursDiff >= -24) {
        return true;
      }
    }
  } catch (e) {
    // 날짜 파싱 실패는 무시
  }
  
  return false;
}

async function getContentFromUrl(url: string): Promise<ContentData | null> {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    
    const blogConfig = getBlogConfig(domain);

    const scrapeOptions: any = {
      url: url,
      formats: ["markdown", "html"],
      onlyMainContent: true,
      removeBase64Images: false,
      waitFor: blogConfig?.waitFor || 3000,
      timeout: 60000,
    };

    if (blogConfig) {
      if (blogConfig.contentSelector) {
        scrapeOptions.actions = [
          {
            type: "wait",
            milliseconds: blogConfig.waitFor || 3000
          },
          {
            type: "scroll",
            direction: "down"
          },
          {
            type: "wait",
            milliseconds: 1000
          }
        ];
      }
      
      if (blogConfig.excludeTags) {
        scrapeOptions.excludeTags = blogConfig.excludeTags;
      }
    }

    if (domain.includes('huggingface.co')) {
      scrapeOptions.actions = [
        { type: "wait", milliseconds: 5000 },
        { type: "scroll", direction: "down" },
        { type: "wait", milliseconds: 1000 },
        { type: "scroll", direction: "down" },
        { type: "wait", milliseconds: 1000 },
        { type: "scroll", direction: "down" },
        { type: "wait", milliseconds: 1000 }
      ];
      
      scrapeOptions.includeTags = ["article", ".prose", ".markdown", ".blog-post-content"];
    }

    const response = await axios.post(`${CONFIG.FIRECRAWL_API_URL}/scrape`, scrapeOptions, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.FIRECRAWL_API_KEY}`
      },
      timeout: 60000
    });
    
    if (!response.data || response.data.error) {
      console.error(`스크래핑 API 오류: ${response.data?.error || '알 수 없는 오류'}`);
      return null;
    }

    const responseData = response.data.data || response.data;
    const content = responseData.markdown || '';
    const html = responseData.html || '';
    
    const isIncomplete = content.endsWith('...') || 
                         content.endsWith('…') || 
                         /[A-Za-z]$/.test(content);
    
    if (content.includes('404') && (content.includes('Not Found') || content.includes('Page not found')) ||
        html.includes('<title>404') ||
        html.toLowerCase().includes('page not found') ||
        response.data.statusCode === 404 ||
        responseData.metadata?.statusCode === 404) {
      return null;
    }

    const minContentLength = 500;
    if (content.length < minContentLength || isIncomplete) {
      if (domain.includes('huggingface.co')) {
        const huggingFaceResponse = await apiCallWithRetry(() => 
          axios.post(`${CONFIG.FIRECRAWL_API_URL}/scrape`, {
            ...scrapeOptions,
            formats: ["markdown", "html", "screenshot@fullPage"],
            onlyMainContent: false,
            removeBase64Images: false,
            actions: [
              { type: "wait", milliseconds: 5000 },
              { type: "scroll", direction: "down" },
              { type: "wait", milliseconds: 2000 },
              { type: "scroll", direction: "down" },
              { type: "wait", milliseconds: 2000 }
            ]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${CONFIG.FIRECRAWL_API_KEY}`
            },
            timeout: 90000
          })
        );
        
        const huggingFaceData = huggingFaceResponse.data.data || huggingFaceResponse.data;
        if (huggingFaceData && huggingFaceData.markdown && huggingFaceData.markdown.length > minContentLength) {
          return {
            fullContent: huggingFaceData.markdown,
            imageUrls: extractImageUrls(huggingFaceData.html || ''),
            videoUrls: extractVideoUrls(huggingFaceData.html || '')
          };
        }
      }
      
      const retryResponse = await apiCallWithRetry(() =>
        axios.post(`${CONFIG.FIRECRAWL_API_URL}/scrape`, {
          ...scrapeOptions, 
          formats: ["html", "rawHtml"],
          onlyMainContent: false,
          actions: [
            { type: "wait", milliseconds: 5000 },
            { type: "scroll", direction: "down" },
            { type: "wait", milliseconds: 2000 }
          ]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.FIRECRAWL_API_KEY}`
          },
          timeout: 60000
        })
      );
      
      const retryData = retryResponse.data.data || retryResponse.data;
      
      if (retryData && (retryData.html || retryData.rawHtml)) {
        const htmlContent = retryData.html || retryData.rawHtml;
        const processedHtml = processHtmlContent(htmlContent);
        
        if (processedHtml.length >= minContentLength) {
          return {
            fullContent: processedHtml,
            imageUrls: extractImageUrls(htmlContent),
            videoUrls: extractVideoUrls(htmlContent)
          };
        }
      }
      
      return null;
    }

    return {
      fullContent: content,
      imageUrls: extractImageUrls(html),
      videoUrls: extractVideoUrls(html)
    };
  } catch (error) {
    console.error(`콘텐츠 추출 중 오류 발생:`, error);
    return null;
  }
}

function processHtmlContent(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function scrapeSource(source: string, now: Date): Promise<Story[]> {
  console.log(`처리 중인 소스: ${source}`);
  
  try {
    await sleep(500, CONFIG.REQUEST_DELAY);
    
    const todayISO = now.toISOString().split('T')[0];
    
    const promptForStructured = getStructuredDataPrompt(source, todayISO, now);
    
    const promptForContent = getContentExtractionPrompt(source);
    
    const scrapeResult = await apiCallWithRetry(async () => {
      return await app.extract([source], {
        prompt: promptForStructured,
        schema: StoriesSchema,
      });
    });
    
    if (!scrapeResult.success) {
      throw new Error(`Failed to scrape: ${scrapeResult.error}`);
    }
    
    const todayStories = scrapeResult.data as { stories: Story[] };
    
    if (!todayStories || !todayStories.stories || todayStories.stories.length === 0) {
      return [];
    }
    
    const filteredStories: Story[] = [];
    const limitedStories = todayStories.stories.slice(0, CONFIG.MAX_STORIES_PER_SOURCE);
    
    for (const story of limitedStories) {
      const isRecent = isLikelyRecent(story.date_posted);
          
      if (isRecent) {
        filteredStories.push(story);
        
        if (story.link) {
          try {
            await sleep(CONFIG.REQUEST_DELAY, CONFIG.REQUEST_DELAY * 2);
            
            const contentData = await getContentFromUrl(story.link);
            
            if (contentData) {
              story.fullContent = contentData.fullContent || '';
              story.imageUrls = contentData.imageUrls || [];
              story.videoUrls = contentData.videoUrls || [];
                  
              if (typeof storeFullContent === 'function' && story.fullContent) {
                try {
                  const storyId = crypto.createHash('md5').update(story.link).digest('hex');
                  
                  const storageResult = await storeFullContent(storyId, story.headline, story.fullContent);
                  if (storageResult?.id) {
                    story.content_storage_id = storageResult.id;
                    story.content_storage_method = storageResult.method;
                  }
                } catch (storageError) {
                  console.error('원문 저장 실패:', storageError);
                }
              }
            }
          } catch (contentError) {
            console.error(`내용 추출 중 오류 발생:`, contentError);
          }
          
          if (!story.fullContent || story.fullContent.trim() === '') {
            story.fullContent = story.headline;
          }
        }
      }
    }
    
    return filteredStories;
  } catch (error) {
    console.error(`Error scraping ${source}:`, error);
    return [];
  }
}

function getStructuredDataPrompt(source: string, todayISO: string, now: Date): string {
  return `
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
}

function getContentExtractionPrompt(source: string): string {
  return `
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
}

export async function scrapeSources(
  sources: { identifier: string }[],
): Promise<Story[]> {
  const now = new Date();
  
  console.log(`총 ${sources.length}개의 소스를 처리합니다.`);
  console.log(`시스템 시간: ${now.toISOString()}`);

  try {
    const allStories: Story[] = [];
    
    for (let i = 0; i < sources.length; i += CONFIG.BATCH_SIZE) {
      const batch = sources.slice(i, i + CONFIG.BATCH_SIZE);
      console.log(`소스 배치 ${Math.floor(i/CONFIG.BATCH_SIZE) + 1}/${Math.ceil(sources.length/CONFIG.BATCH_SIZE)} 처리 중 (${batch.length}개)...`);
      
      for (const sourceObj of batch) {
        const sourceStories = await scrapeSource(sourceObj.identifier, now);
        allStories.push(...sourceStories);
        
        if (sourceObj !== batch[batch.length - 1]) {
          await sleep(CONFIG.REQUEST_DELAY, CONFIG.REQUEST_DELAY * 1.5);
        }
      }
      
      if (i + CONFIG.BATCH_SIZE < sources.length) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
      }
    }
    
    console.log(`모든 소스에서 총 ${allStories.length}개의 스토리를 찾았습니다.`);
    return allStories;
  } catch (error) {
    console.error("Error in scrapeSources:", error);
    return [];
  }
}
