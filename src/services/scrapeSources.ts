import dotenv from "dotenv";
import { z } from "zod";
import axios from "axios";
import { storeFullContent } from './contentStorage';
import crypto from 'crypto';
import { crawlWebsites, checkCrawl4aiInstallation, installCrawl4ai, dynamicCrawlWebsites, Story as Crawl4aiStory, classifyContentHierarchically } from './crawl4aiService';
import { getCategoryFromContent } from './sendDraft';

dotenv.config();

// 설정 상수
const CONFIG = {
  BATCH_SIZE: parseInt(process.env.CRAWL_BATCH_SIZE || '3', 10),
  BATCH_DELAY: parseInt(process.env.CRAWL_BATCH_DELAY || '15000', 10), // 15초로 증가
  REQUEST_DELAY: parseInt(process.env.CRAWL_ITEM_DELAY || '3000', 10), // 3초로 증가
  MAX_STORIES_PER_SOURCE: parseInt(process.env.MAX_STORIES_PER_SOURCE || '3', 10),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10)
};

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
  content_storage_method: z.string().optional().describe("Method used to store the content"),
  category: z.string().optional().describe("Main category of the content"),
  metadata: z.object({
    subCategories: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    confidence: z.number().optional()
  }).optional().describe("Additional metadata about the content classification")
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
      return amount <= 36; // 24시간에서 36시간으로 확장
    }
    
    if (unit.includes('minute') || unit.includes('분') || unit === 'm') {
      return true;
    }
    
    if (unit.includes('day') || unit.includes('일') || unit === 'd') {
      return amount <= 3; // 2일에서 3일로 확장
    }
  }
  
  const oldKeywords = [
    'last week', 'last month', 'last year', 
    '지난주', '지난달', '작년', 
    '4 days ago', '5 days ago', '6 days ago', '7 days ago'
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
      
      if (hoursDiff <= 36 && hoursDiff >= -36) {
        return true;
      }
    }
  } catch (e) {
    // 날짜 파싱 실패는 무시
  }
  
  return false;
}

// HTML 콘텐츠 처리 함수
function processHtmlContent(html: string): string {
  if (!html) return '';
  
  // HTML 태그 제거하되 일부 기본 형식은 유지
  let content = html
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/blockquote>/gi, '\n\n')
    .replace(/<\/pre>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ') // 나머지 태그 제거
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ') // 여러 공백을 하나로 압축
    .trim();
  
  return content;
}

// crawl4ai를 사용한 소스 스크래핑 함수
async function scrapeSource(source: string, now: Date): Promise<Story[]> {
  try {
    console.log(`소스 스크래핑 시작: ${source}`);
    
    // 사용할 LLM 프로바이더 결정 (OpenAI를 기본으로 설정)
    let llmProvider: 'openai' | 'together' | 'deepseek' = 'openai';
    if (process.env.TOGETHER_API_KEY && process.env.TOGETHER_API_KEY !== 'your_together_api_key_here') {
      llmProvider = 'together';
    } else if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 10) {
      llmProvider = 'deepseek';
    }
    
    console.log(`LLM 프로바이더 선택: ${llmProvider}`);
    
    // 크롤링할 때 24시간 이내의 내용을 가져오도록 지정
    const todayDate = now.toISOString().split('T')[0];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDate = yesterday.toISOString().split('T')[0];
    console.log(`최근 24시간(${yesterdayDate} ~ ${todayDate}) 내의 AI 관련 기사를 크롤링합니다.`);
    
    // crawl4ai를 사용하여 웹사이트 크롤링
    // 추가 안내 포함: 최신(오늘) 기사, AI 관련 콘텐츠만 크롤링
    const crawlResults = await crawlWebsites(
      [{ identifier: source }],
      { 
        llmProvider,
        // 크롤러가 오늘 날짜의 AI 관련 콘텐츠에 집중하도록 메타데이터 추가
        meta: {
          targetDate: yesterdayDate,
          contentFocus: 'AI technology, machine learning, large language models, deep learning',
          prioritizeRecent: true
        }
      }
    );
    
    // 결과 가공
    const stories: Story[] = [];
    
    for (const rawStory of crawlResults) {
      // 최신 게시물만 필터링 (더 엄격한 필터링 적용)
      if (rawStory.date_posted && isLikelyRecent(rawStory.date_posted)) {
        const story: Story = {
          headline: rawStory.headline,
          link: rawStory.link,
          date_posted: rawStory.date_posted,
          fullContent: rawStory.fullContent,
          imageUrls: rawStory.imageUrls || [],
          videoUrls: rawStory.videoUrls || [],
          popularity: rawStory.popularity || 'N/A'
        };
        
        // 임베딩 기반 고급 콘텐츠 분석 수행 (새 기능)
        if (story.fullContent) {
          try {
            // 콘텐츠 길이에 따라 샘플링하되, 너무 길지 않게 제한
            const contentForAnalysis = story.headline + "\n\n" + 
              (story.fullContent.length > 4000 
                ? story.fullContent.substring(0, 2000) 
                : story.fullContent.substring(0, Math.min(2000, story.fullContent.length)));
            
            console.log(`"${story.headline}" 콘텐츠에 대한 고급 카테고리 분석 수행...`);
            
            // API 사용량 제한을 위한 지연 추가
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
              // 계층적 카테고리 분류 수행 (일부 오류 확인 후)
              const categoryResult = await classifyContentHierarchically(contentForAnalysis);
              
              // 분석 결과 로그 출력
              console.log(`- 메인 카테고리: ${categoryResult.mainCategory} (신뢰도: ${(categoryResult.confidence * 100).toFixed(1)}%)`);
              if (categoryResult.subCategories.length > 0) {
                console.log(`- 서브 카테고리: ${categoryResult.subCategories.join(', ')}`);
              }
              if (categoryResult.topics.length > 0) {
                console.log(`- 관련 토픽: ${categoryResult.topics.join(', ')}`);
              }
              
              // 카테고리 정보 추가
              story.category = categoryResult.mainCategory;
              
              // 추가 메타데이터 저장
              story.metadata = {
                subCategories: categoryResult.subCategories,
                topics: categoryResult.topics,
                confidence: categoryResult.confidence
              };
            } catch (analysisError) {
              console.error(`콘텐츠 분석 오류:`, analysisError);
              // 기본 카테고리 설정
              story.category = getCategoryFromContent(undefined, story.fullContent);
              
              // 기본 메타데이터 설정
              story.metadata = {
                subCategories: [],
                topics: [],
                confidence: 0.5
              };
            }
          } catch (error) {
            console.error(`콘텐츠 분석 과정 전체 오류:`, error);
            // 기본 카테고리 설정
            story.category = getCategoryFromContent(undefined, story.fullContent);
          }
          
          // 전체 내용 저장 (필요한 경우)
          try {
            const contentHash = crypto.createHash('md5').update(story.fullContent).digest('hex');
            const storageResult = await storeFullContent(contentHash, story.headline, story.fullContent);
            
            if (storageResult.id) {
              story.content_storage_id = storageResult.id;
              story.content_storage_method = storageResult.method;
            }
          } catch (error) {
            console.error('콘텐츠 저장 오류:', error);
          }
        }
        
        stories.push(story);
      }
    }
    
    // 최대 스토리 수 제한
    return stories.slice(0, CONFIG.MAX_STORIES_PER_SOURCE);
    
  } catch (error) {
    console.error(`소스 스크래핑 오류 (${source}):`, error);
    return [];
  }
}

/**
 * API 요청 지연을 위한 유틸리티 함수
 * 요청 간 일정 시간을 대기하여 속도 제한 초과를 방지합니다.
 */
async function delayBetweenRequests(minDelay = 3000, maxDelay = 5000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  console.log(`요청 사이 ${delay}ms 대기 중...`);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 소스 목록에서 스토리를 스크래핑합니다.
 * crawl4ai를 사용하여 LLM 기반 자동 네비게이션 방식으로 크롤링합니다.
 */
export async function scrapeSources(
  sources: { identifier: string }[],
): Promise<Story[]> {
  console.log("Fetching sources...");
  
  // 테스트 모드인 경우 첫 번째 소스만 사용
  if (process.env.TEST_MODE === "true") {
    console.log(`테스트용 단일 소스 사용: ${sources[0].identifier}`);
    sources = [sources[0]];
  }
  
  console.log("모든 소스 목록:", sources);
  
  // 스크래핑 시작 시간 기록
  const startTime = new Date();
  console.log(`스크래핑 시작: ${startTime.toISOString()}`);
  
  let allStories: Story[] = [];
  
  // crawl4ai 설치 확인 및 설치
  const installed = await checkCrawl4aiInstallation();
  if (!installed) {
    console.log("crawl4ai가 설치되어 있지 않습니다. 설치를 시도합니다...");
    const installSuccess = await installCrawl4ai();
    if (!installSuccess) {
      console.error("crawl4ai 설치 실패");
    }
  }
  
  // 현재 날짜와 어제 날짜 설정 (24시간 이내 기사 크롤링용)
  const today = new Date();
  const todayFormatted = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayFormatted = yesterday.toISOString().split('T')[0];
  
  // 크롤링 방식 선택 (환경 변수로 제어)
  const useDynamicCrawling = process.env.USE_DYNAMIC_CRAWLING === "true";
  console.log(`크롤링 방식: ${useDynamicCrawling ? '동적 크롤링' : '정적 크롤링'}`);
  
  try {
    if (useDynamicCrawling) {
      // 동적 크롤링 사용
      console.log("Playwright를 사용한 동적 크롤링 시작...");
      
      // 동적 크롤링 실행
      const crawlResults = await dynamicCrawlWebsites(sources, {
        targetDate: yesterdayFormatted, // 어제 날짜로 설정하여 24시간 이내 기사 포함
        contentFocus: "AI, machine learning, artificial intelligence, neural network, large language model, LLM",
        maxLinksPerSource: 5
      });
      
      for (const story of crawlResults) {
        // 콘텐츠 저장
        if (story.fullContent && story.fullContent.length > 100) {
          try {
            // 콘텐츠 해시 생성 (파일명 용)
            const contentHash = crypto.createHash('md5').update(story.link + story.headline).digest('hex');
            
            // 콘텐츠 저장
            console.log(`원문 저장 시작: ${story.headline} (${story.fullContent.length} 바이트)`);
            
            // 이미 저장된 내용이 있는지 확인
            const existingContent = await storeFullContent(
              story.headline, 
              story.fullContent, 
              contentHash
            );
            
            if (existingContent) {
              console.log(`이미 저장된 콘텐츠가 있습니다: ${story.headline}`);
            } else {
              console.log(`원문을 데이터베이스에 저장했습니다 (${story.fullContent.length} 바이트): ${story.headline} (ID: ${contentHash})`);
            }
            
            // 카테고리 분석 (완전히 새로운 콘텐츠인 경우만)
            if (!existingContent) {
              console.log(`"${story.headline}" 콘텐츠에 대한 고급 카테고리 분석 수행...`);
              
              // 계층적 카테고리 분류 함수 사용
              const categoryResult = await classifyContentHierarchically(story.fullContent);
              
              // typescript 호환성을 위한 타입 확장
              const enrichedStory: any = story;
              enrichedStory.category = categoryResult.mainCategory;
              enrichedStory.metadata = {
                subCategories: categoryResult.subCategories,
                topics: categoryResult.topics,
                confidence: categoryResult.confidence
              };
              
              console.log(`- 메인 카테고리: ${categoryResult.mainCategory} (신뢰도: ${(categoryResult.confidence * 100).toFixed(1)}%)`);
            }
            
            // 스토리 추가 - 타입 안전하게 변환
            const typedStory: Story = {
              headline: story.headline,
              link: story.link,
              date_posted: story.date_posted,
              fullContent: story.fullContent,
              imageUrls: story.imageUrls,
              videoUrls: story.videoUrls,
              popularity: story.popularity,
              content_storage_id: story.content_storage_id,
              content_storage_method: story.content_storage_method,
              category: (story as any).category || '연구 동향',
              metadata: (story as any).metadata || {
                subCategories: [],
                topics: [],
                confidence: 0.5
              }
            };
            
            allStories.push(typedStory);
          } catch (storageError) {
            console.error(`콘텐츠 저장 오류 (${story.headline}):`, storageError);
          }
        }
      }
    } else {
      // 정적 크롤링 사용 (기존 코드)
      console.log("crawl4ai를 사용한 정적 크롤링 시작...");
      
      // crawl4ai 기반 크롤링 실행
      const llmProvider = process.env.LLM_PROVIDER as 'openai' | 'together' | 'deepseek' || 'openai';
      console.log(`LLM 프로바이더 선택: ${llmProvider}`);
      
      console.log(`최근 24시간(${yesterdayFormatted} ~ ${todayFormatted}) 내의 AI 관련 기사를 크롤링합니다.`);
      
      const crawlResults = await crawlWebsites(sources, {
        llmProvider,
        batchDelay: CONFIG.BATCH_DELAY,
        meta: {
          targetDate: yesterdayFormatted, // 어제 날짜로 설정하여 24시간 이내 기사 포함
          contentFocus: "AI news, machine learning, LLM, large language model, neural network",
          prioritizeRecent: true
        }
      });
      
      // 결과 처리 (기존 처리 로직)
      for (const story of crawlResults) {
        if (story.fullContent && story.fullContent.length > 100) {
          try {
            // 콘텐츠 해시 생성
            const contentHash = crypto.createHash('md5').update(story.link + story.headline).digest('hex');
            
            // 콘텐츠 저장
            console.log(`원문 저장 시작: ${story.headline} (${story.fullContent.length} 바이트)`);
            
            // 이미 저장된 내용이 있는지 확인
            const existingContent = await storeFullContent(
              story.headline, 
              story.fullContent, 
              contentHash
            );
            
            if (existingContent) {
              console.log(`이미 저장된 콘텐츠가 있습니다: ${story.headline}`);
            } else {
              console.log(`원문을 데이터베이스에 저장했습니다 (${story.fullContent.length} 바이트): ${story.headline} (ID: ${contentHash})`);
            }
            
            // 카테고리 분석 (완전히 새로운 콘텐츠인 경우만)
            if (!existingContent) {
              console.log(`"${story.headline}" 콘텐츠에 대한 고급 카테고리 분석 수행...`);
              
              // 계층적 카테고리 분류 함수 사용
              const categoryResult = await classifyContentHierarchically(story.fullContent);
              
              // typescript 호환성을 위한 타입 확장
              const enrichedStory: any = story;
              enrichedStory.category = categoryResult.mainCategory;
              enrichedStory.metadata = {
                subCategories: categoryResult.subCategories,
                topics: categoryResult.topics,
                confidence: categoryResult.confidence
              };
              
              console.log(`- 메인 카테고리: ${categoryResult.mainCategory} (신뢰도: ${(categoryResult.confidence * 100).toFixed(1)}%)`);
            }
            
            // 스토리 추가 - 타입 안전하게 변환
            const typedStory: Story = {
              headline: story.headline,
              link: story.link,
              date_posted: story.date_posted,
              fullContent: story.fullContent,
              imageUrls: story.imageUrls,
              videoUrls: story.videoUrls,
              popularity: story.popularity,
              content_storage_id: story.content_storage_id,
              content_storage_method: story.content_storage_method,
              category: (story as any).category || '연구 동향',
              metadata: (story as any).metadata || {
                subCategories: [],
                topics: [],
                confidence: 0.5
              }
            };
            
            allStories.push(typedStory);
          } catch (storageError) {
            console.error(`콘텐츠 저장 오류 (${story.headline}):`, storageError);
          }
        }
      }
    }
    
    // 주요 로그 정보 출력
    console.log(`스크래핑 완료: 총 ${allStories.length}개의 스토리를 찾았습니다.`);
    
    // 총 바이트 계산
    const totalBytes = allStories.reduce((sum, story) => {
      return sum + (story.fullContent?.length || 0);
    }, 0);
    
    console.log(`스크래핑 결과: ${allStories.length}개 스토리 (${totalBytes} 바이트)`);
    
    // 결과 반환
    return allStories;
  } catch (error) {
    console.error("스크래핑 프로세스 오류:", error);
    
    // 오류 발생해도 지금까지 수집된 스토리 반환
    return allStories;
  }
}
