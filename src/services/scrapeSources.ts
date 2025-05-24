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
  content_storage_method: z.string().optional().describe("Method used to store the content"),  source: z.string().optional().describe("Source website domain"),  category: z.string().optional().describe("Main category of the content"),
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

function isLikelyRecent(dateString: string, timeframeHours: number = 48): boolean {
  if (!dateString || dateString.trim() === '') {
    console.warn(`날짜 문자열이 비어있어 최신 게시물로 간주하지 않음`);
    return false;
  }
  
  const dateLower = dateString.toLowerCase();
  console.log(`날짜 문자열 "${dateString}" 최신성 검사 중 (${timeframeHours}시간 기준)...`);
  
  // 1. 명시적으로 최근 시간을 나타내는 키워드 확인 (더 많은 키워드 추가)
  const recentTimeKeywords = [
    'today', 'hours ago', 'minutes ago', 'just now', 'hour ago', 'min ago', 'mins ago',
    '시간 전', '분 전', '방금', 'an hour ago', 'a minute ago', 'a few minutes ago'
  ];
  
  if (recentTimeKeywords.some(keyword => dateLower.includes(keyword))) {
    // "X hours ago" 패턴은 아래에서 별도 처리
    if (!dateLower.includes('days ago') && (dateLower.includes('hours ago') || dateLower.includes('hour ago') || dateLower.includes('시간 전'))) {
        // Pass to specific hour check
    } else if (dateLower.includes('days ago')) {
        // Pass to specific day check
    } else {
        console.log(`"${dateString}"는 최근 시간 키워드(${recentTimeKeywords.find(k => dateLower.includes(k))})를 포함하여 최신으로 간주함`);
        return true;
    }
  }
  
  // 2. "X days ago" 패턴 매칭을 더 엄격하게 처리
  const daysAgoPattern = /(\d+)\s*days?\s*ago/i;
  const daysAgoMatch = dateLower.match(daysAgoPattern);
  
  if (daysAgoMatch) {
    const days = parseInt(daysAgoMatch[1]);
    console.log(`"${dateString}" - ${days}일 전으로 파싱됨`);
    const isRecent = days * 24 <= timeframeHours; // timeframeHours (예: 48시간) 이내
    console.log(`"${dateString}"는 ${days}일 전이므로 ${isRecent ? '최신으로 간주' : '최신이 아님'} (${timeframeHours}시간 기준)`);
    return isRecent;
  }
  
  // 3. "yesterday" 처리
  if (dateLower.includes('yesterday')) {
    console.log(`"${dateString}"는 'yesterday'를 포함하여 최신으로 간주함 (${timeframeHours}시간 기준이면 24 <= timeframeHours 확인)`);
    return 24 <= timeframeHours; // 어제 (24시간 전)가 timeframeHours 이내인지 확인
  }
  
  // 4. "X minutes/hours ago" 패턴 매칭 (정규식 개선)
  const timePattern = /(\d+)\s*(hour|hours|minute|minutes|시간|분|h|m)\s*(ago|전)?/i;
  const timeMatch = dateLower.match(timePattern);
  
  if (timeMatch) {
    const amount = parseInt(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    
    // 시간 단위 (timeframeHours 내로 제한)
    if (unit.includes('hour') || unit.includes('시간') || unit === 'h') {
      const isRecent = amount <= timeframeHours;
      console.log(`"${dateString}"는 ${amount}시간 전이므로 ${isRecent ? '최신으로 간주' : `최신이 아님 (${timeframeHours}시간 기준)`}`);
      return isRecent; 
    }
    
    // 분 단위는 항상 최근으로 간주
    if (unit.includes('minute') || unit.includes('min') || unit.includes('분') || unit === 'm') {
      console.log(`"${dateString}"는 ${amount}분 전이므로 최신으로 간주함`);
      return true;
    }
  }
  
  // 5. 오래된 콘텐츠 키워드 명시적 체크
  const oldKeywords = [
    'last month', 'last year', 'last week',
    '지난달', '작년', '지난주', '지난 달', '지난 해',
    '2 days ago', '3 days ago', '4 days ago', '5 days ago', 'weeks ago'
  ];
  
  if (oldKeywords.some(keyword => dateLower.includes(keyword))) {
    console.log(`"${dateString}"는 오래된 콘텐츠로 판별됨 (${oldKeywords.find(k => dateLower.includes(k))})`);
    return false;
  }
  
  // 6. 오늘 날짜 포함 확인 (더 엄격하게)
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  
  if (dateLower.includes(todayStr)) {
    console.log(`"${dateString}"는 오늘 날짜(${todayStr})를 포함하여 최신으로 간주함`);
    return true;
  }
  
  // 7. 실제 날짜 비교 (시간 범위 제한)
  try {
    const date = new Date(dateString);
    
    if (!isNaN(date.getTime())) {
      const now = new Date();
      const timeDiff = now.getTime() - date.getTime();
      const hoursDiff = timeDiff / (1000 * 60 * 60);
      
      // 시간 범위를 timeframeHours로 명확히 제한
      const isRecent = hoursDiff <= timeframeHours;
      console.log(`"${dateString}"는 ${hoursDiff.toFixed(1)}시간 전으로, ${isRecent ? `${timeframeHours}시간 이내로 최신` : `${timeframeHours}시간 초과하여 제외됨`}`);
      return isRecent;
    }
  } catch (error) {
    console.error(`날짜 파싱 오류 (${dateString}):`, error);
  }
  
  // 8. 판별 불가능한 경우 로그 추가하고 보수적으로 접근 (제외)
  console.warn(`날짜 판별 불가: "${dateString}" - 최신 게시물로 간주하지 않음`);
  return false; // 판별 불가능한 경우 보수적으로 접근 (제외)
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
    // 추가 안내 포함: 최근 24시간 기사, AI 관련 콘텐츠 크롤링
    const crawlResults = await crawlWebsites(
      [{ identifier: source }],
      { 
        llmProvider,
        // 크롤러가 최근 24시간 내 AI 관련 콘텐츠에 집중하도록 메타데이터 추가
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
  sources: { identifier: string; maxItems?: number; timeframeHours?: number }[],
): Promise<Story[]> {
  console.log("Fetching sources...");
  
  // 테스트 모드인 경우 첫 번째 소스만 사용
  if (process.env.TEST_MODE === "true") {
    console.log(`테스트용 단일 소스 사용: ${sources[0].identifier}`);
    sources = [sources[0]];
  }
  
  // 소스별 설정 적용 (getCronSources에서 전달된 값을 우선 사용)
  const validatedSources = sources.map(source => ({
    ...source,
    maxItems: source.maxItems || 1, // 전달된 maxItems가 없으면 1로 설정
    timeframeHours: source.timeframeHours || 48 // 전달된 timeframeHours가 없으면 48으로 설정 (기본값)
  }));
  
  console.log("모든 소스 파라미터 검증 후 설정:");
  validatedSources.forEach(source => {
    console.log(`- ${source.identifier}: 최대 ${source.maxItems}개 항목, ${source.timeframeHours}시간 이내`);
  });
  
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
      console.log(`동적 크롤링 사용 설정됨 (소스: ${validatedSources.map(s=>s.identifier).join(', ')})`);
      
      const crawlResults = await dynamicCrawlWebsites(validatedSources, {
        contentFocus: "AI, machine learning, artificial intelligence, neural network, large language model, LLM",
      });
      
            // 중복 로그 제거 - dynamicCrawlWebsites에서 이미 로깅됨
      
      // timeframeHours (예: 48시간) 이내 게시물만 명시적으로 필터링
      const currentSourceTimeframe = validatedSources[0]?.timeframeHours || 48;
      const filteredResults = crawlResults.filter(story => isLikelyRecent(story.date_posted || '', currentSourceTimeframe));
      console.log(`${currentSourceTimeframe}시간 필터링 후 (동적): ${filteredResults.length}개 스토리 남음`);
      
      // 각 소스별로 1개씩만 가져오도록 그룹화
      const storyBySource = new Map<string, Story>();
      for (const story of filteredResults) {
        // 각 소스별 가장 최신 게시물 확인
        const source = story.link.match(/^https?:\/\/([^\/]+)/i)?.[1] || story.link;
        if (!storyBySource.has(source) || isNewer(story.date_posted, storyBySource.get(source)?.date_posted)) {
          storyBySource.set(source, story);
        }
      }
      
      // 최종 스토리 모음
      const finalResults = Array.from(storyBySource.values());
      console.log(`소스별 중복 제거 후 최종: ${finalResults.length}개 스토리`);
      
      // 결과 처리
      allStories = finalResults;
    } else {
      // 정적 크롤링 사용 (기존 코드)
      console.log("crawl4ai를 사용한 정적 크롤링 시작...");
      
      // crawl4ai 기반 크롤링 실행
      const llmProvider = process.env.LLM_PROVIDER as 'openai' | 'together' | 'deepseek' || 'openai';
      console.log(`LLM 프로바이더 선택: ${llmProvider}`);
      
      console.log(`최근 ${validatedSources[0]?.timeframeHours || 48}시간(${yesterdayFormatted} 이후) 내의 AI 관련 기사를 크롤링합니다.`);
      
      const crawlResultsStatic = await crawlWebsites(validatedSources, {
        llmProvider,
        batchDelay: CONFIG.BATCH_DELAY,
        meta: {
          targetDate: yesterdayFormatted, // timeframeHours 기준으로 계산된 targetDate 전달
          contentFocus: "AI news, machine learning, LLM, large language model, neural network",
          prioritizeRecent: true
        }
      });
      
      // 결과 검증
      console.log(`정적 크롤링 후 결과: ${crawlResultsStatic.length}개 스토리 수집됨`);
      
      // 날짜 정보 로깅
      crawlResultsStatic.forEach((story, idx) => {
        console.log(`${idx + 1}. "${story.headline}" - 날짜: ${story.date_posted || '날짜 없음'}`);
      });
      
      // 정적 크롤링 결과에 대해서는 isLikelyRecent 필터링 유지 (필요시)
      const filteredResultsStatic = crawlResultsStatic.filter(story => isLikelyRecent(story.date_posted || '', validatedSources[0]?.timeframeHours || 48));
      console.log(`${validatedSources[0]?.timeframeHours || 48}시간 필터링 후 (정적): ${filteredResultsStatic.length}개 스토리 남음`);
      
      // 최종 스토리 모음
      allStories = filteredResultsStatic;
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

/**
 * 두 날짜 문자열 중 어느 것이 더 최신인지 비교
 * @param date1 첫 번째 날짜 문자열
 * @param date2 두 번째 날짜 문자열
 * @returns 첫 번째 날짜가 더 최신이면 true, 아니면 false
 */
function isNewer(date1?: string, date2?: string): boolean {
  if (!date1) return false;
  if (!date2) return true;
  
  // 두 날짜 모두 있을 경우
  
  // "X days ago" 패턴 처리
  const daysAgo1 = date1.match(/(\d+)\s*days?\s*ago/i);
  const daysAgo2 = date2.match(/(\d+)\s*days?\s*ago/i);
  
  if (daysAgo1 && daysAgo2) {
    // 둘 다 "X days ago" 형식이면 숫자가 작을수록 최신
    return parseInt(daysAgo1[1]) < parseInt(daysAgo2[1]);
  }
  
  // "X hours ago" 패턴 처리
  const hoursAgo1 = date1.match(/(\d+)\s*(hour|hours)\s*ago/i);
  const hoursAgo2 = date2.match(/(\d+)\s*(hour|hours)\s*ago/i);
  
  if (hoursAgo1 && hoursAgo2) {
    // 둘 다 "X hours ago" 형식이면 숫자가 작을수록 최신
    return parseInt(hoursAgo1[1]) < parseInt(hoursAgo2[1]);
  }
  
  // "X minutes ago" 패턴 처리
  const minsAgo1 = date1.match(/(\d+)\s*(minute|minutes|min|mins)\s*ago/i);
  const minsAgo2 = date2.match(/(\d+)\s*(minute|minutes|min|mins)\s*ago/i);
  
  if (minsAgo1 && minsAgo2) {
    // 둘 다 "X minutes ago" 형식이면 숫자가 작을수록 최신
    return parseInt(minsAgo1[1]) < parseInt(minsAgo2[1]);
  }
  
  // "days" vs "hours" vs "minutes" 비교
  if (daysAgo1) {
    if (hoursAgo2 || minsAgo2) return false; // 시간/분 단위가 일 단위보다 최신
  } else if (hoursAgo1) {
    if (daysAgo2) return true; // 시간 단위가 일 단위보다 최신
    if (minsAgo2) return false; // 분 단위가 시간 단위보다 최신
  } else if (minsAgo1) {
    if (daysAgo2 || hoursAgo2) return true; // 분 단위가 일/시간 단위보다 최신
  }
  
  // 일반적인 날짜 형식 비교 시도
  try {
    const d1 = new Date(date1).getTime();
    const d2 = new Date(date2).getTime();
    if (!isNaN(d1) && !isNaN(d2)) {
      return d1 > d2; // 타임스탬프가 클수록 최신
    }
  } catch (e) {
    // 날짜 파싱 실패 시 무시
  }
  
  // 비교 불가능한 경우 첫 번째 날짜를 우선시
  return true;
}
