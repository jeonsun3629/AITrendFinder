import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';
// import { PlaywrightCrawler, launchPlaywright, sleep } from 'crawl4ai';
// import { Story } from '../types';
// import { cleanUpUrl, isValidUrl } from '../utils/urlUtils';
import { ApiCache, withCache } from '../utils/apiCache';
import { parse, parseISO, differenceInHours } from 'date-fns';

// python-shell 관련 타입 정의
interface PythonShellOptions {
  mode?: 'text' | 'json' | 'binary';
  pythonPath?: string;
  pythonOptions?: string[];
  scriptPath?: string;
  args?: string[];
  [key: string]: any;
}

interface PythonShellError extends Error {
  traceback?: string;
  executable?: string;
  options?: PythonShellOptions;
  args?: string[];
  [key: string]: any;
}

// 스키마 정의
const StorySchema = z.object({
  headline: z.string().describe("Story or post headline"),
  link: z.string().describe("A link to the post or story"),
  date_posted: z.string().describe("The date the story or post was published"),
  fullContent: z.string().optional().describe("Full content of the story or post"),
  imageUrls: z.array(z.string()).optional().describe("Image URLs from the post"),
  videoUrls: z.array(z.string()).optional().describe("Video URLs from the post"),
  popularity: z.string().optional().describe("Popularity metrics like retweets, likes, etc."),
  content_storage_id: z.string().optional().describe("ID of the stored content in the database"),
  content_storage_method: z.string().optional().describe("Method used to store the content")
});

export type Story = z.infer<typeof StorySchema>;

interface CrawlResult {
  source: string;
  stories: Story[];
  error?: string;
}

/**
 * 임시 Python 스크립트 파일 생성
 */
function createTempPythonScript(scriptContent: string): string {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `crawl4ai_temp_${Date.now()}.py`);
  fs.writeFileSync(tempFile, scriptContent, { encoding: 'utf-8' });
  return tempFile;
}

/**
 * 단일 웹사이트를 크롤링합니다.
 * @param source 크롤링할 소스 URL
 * @param options 추가 옵션
 * @returns 크롤링 결과
 */
export async function crawlSingleWebsite(
  source: string,
  options: {
    llmProvider?: 'openai' | 'together' | 'deepseek';
    outputPath?: string;
    maxItems?: number;
    timeframeHours?: number;
  } = {}
): Promise<Story[]> {
  try {
    const sourcesJson = JSON.stringify([source]);
    // 임시 디렉토리에 결과 파일 저장
    const outputPath = options.outputPath || path.join(os.tmpdir(), `crawl_result_${Date.now()}.json`);
    const llmProvider = options.llmProvider || 'openai';
    
    // 최대 아이템 수와 시간 제한 설정
    const maxItems = options.maxItems || 2; // 기본값 3개
    const timeframeHours = options.timeframeHours || 48; // 기본값 48시간

    // Python 스크립트 경로
    const scriptPath = path.join(__dirname, '../scripts/crawl.py');
    
    // 스크립트 존재 확인
    if (!fs.existsSync(scriptPath)) {
      console.error(`크롤링 스크립트를 찾을 수 없습니다: ${scriptPath}`);
      const scriptsDir = path.dirname(scriptPath);
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }
      throw new Error(`크롤링 스크립트가 존재하지 않습니다: ${scriptPath}`);
    }

    // Python 스크립트 옵션
    const pythonOptions: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python',
      pythonOptions: ['-u'],
      args: [
        '--sources', sourcesJson,
        '--output', outputPath,
        '--llm_provider', llmProvider,
        '--max_items', maxItems.toString(),
        '--timeframe_hours', timeframeHours.toString()
      ]
    };

    // 스크립트 실행 전 로그 개선
    console.log(`실행할 Python 스크립트: ${scriptPath}`);
    console.log(`Python 매개변수: `);
    console.log(`  - 소스: ${source}`);
    console.log(`  - 출력 파일: ${outputPath}`);
    console.log(`  - LLM 제공자: ${llmProvider}`);
    console.log(`  - 최대 항목 수: ${maxItems}`);
    console.log(`  - 시간 제한(시간): ${timeframeHours}`);
    
    // 스크립트 실행
    console.log(`crawl4ai 크롤링 시작 (${source}) - 최대 ${maxItems}개 항목, ${timeframeHours}시간 이내...`);
    const results = await PythonShell.run(scriptPath, pythonOptions);
    
    // Python 스크립트의 출력 결과 확인 (첫 5줄)
    if (results && results.length > 0) {
      console.log(`Python 스크립트 출력 (처음 5줄):`);
      results.slice(0, 5).forEach((line, i) => {
        console.log(`  ${i+1}. ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
      });
      if (results.length > 5) {
        console.log(`  ... 외 ${results.length - 5}줄`);
      }
    }
    
    // 결과 파일 읽기
    if (fs.existsSync(outputPath)) {
      const rawData = fs.readFileSync(outputPath, { encoding: 'utf-8' });
      const results: CrawlResult[] = JSON.parse(rawData);
      
      // 스토리 추출
      let allStories: Story[] = [];
      for (const result of results) {
        if (result.stories && Array.isArray(result.stories)) {
          allStories.push(...result.stories);
        }
      }
      
      console.log(`Python 스크립트 결과: 총 ${allStories.length}개 스토리 수집됨`);
      
      // JavaScript에서 날짜 필터링 추가
      // Python 스크립트가 날짜를 제대로 필터링하지 않을 경우를 대비
      if (timeframeHours > 0) {
        const now = new Date();
        const timeframeMs = timeframeHours * 60 * 60 * 1000; // 시간을 밀리초로 변환
        
        // 원래 스토리 개수 기록
        const originalCount = allStories.length;
        
        // 각 스토리의 날짜 정보 로깅 (필터링 전)
        console.log(`=== 필터링 전 모든 스토리 날짜 정보 ===`);
        allStories.forEach((story, idx) => {
          console.log(`${idx + 1}. "${story.headline}" - 날짜: ${story.date_posted || '날짜 없음'}`);
        });
        
        // 48시간 이내 게시물만 필터링 - 매우 엄격하게 적용
        allStories = allStories.filter(story => {
          try {
            // 날짜 문자열을 여러 형식으로 시도
            let storyDate: Date | null = null;
            const timeframeMs = timeframeHours * 60 * 60 * 1000; // 밀리초 단위로 변환
            const now = new Date(); 
            
            if (story.date_posted) {
              // "X days ago" 패턴을 명시적으로 확인하고 거부
              const daysAgoMatch = story.date_posted.match(/(\d+)\s*days?\s*ago/i);
              if (daysAgoMatch) {
                const days = parseInt(daysAgoMatch[1]);
                console.log(`"${story.headline}" - 날짜 "${story.date_posted}"는 ${days}일 전으로, ${timeframeHours}시간(약 ${(timeframeHours / 24).toFixed(1)}일) 기준 검사`);
                return days * 24 <= timeframeHours; // timeframeHours (예: 48시간) 이내
              }
              
              // "a day ago", "1 day ago" 패턴 특별 처리
              if (/^(a|1)\s+day\s+ago$/i.test(story.date_posted)) {
                console.log(`"${story.headline}" - 날짜 "${story.date_posted}"는 어제 게시물로 간주 (${timeframeHours}시간 기준)`);
                return 24 <= timeframeHours; // 어제 (24시간 전)가 timeframeHours 이내인지 확인
              }

              // "X hours ago" 패턴 처리
              const hoursAgoMatch = story.date_posted.match(/(\d+)\s*(hour|hr)s?\s*ago/i);
              if (hoursAgoMatch) {
                const hours = parseInt(hoursAgoMatch[1]);
                console.log(`"${story.headline}" - 날짜 "${story.date_posted}"는 ${hours}시간 전 게시물 (${timeframeHours}시간 기준)`);
                return hours <= timeframeHours;
              }
              
              // "X minutes ago", "just now" 등은 항상 최신으로 간주 (timeframeHours 무관)
              if (/(\d+\s*(minute|min)s?\s*ago|just\s*now|바로\s*전|방금|분\s*전)/i.test(story.date_posted)) {
                console.log(`"${story.headline}" - 날짜 "${story.date_posted}"는 매우 최신 게시물로 간주`);
                return true;
              }
              
              // 절대 날짜/시간 문자열 파싱 시도 (다양한 형식 지원)
              const dateFormats = [
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", // ISO8601 확장
                "yyyy-MM-dd'T'HH:mm:ssXXX",    // ISO8601 기본
                "yyyy-MM-dd HH:mm:ss",
                "yyyy-MM-dd HH:mm",
                "yyyy/MM/dd HH:mm:ss",
                "MM/dd/yyyy HH:mm:ss",
                "dd/MM/yyyy HH:mm:ss",
                "yyyy.MM.dd HH:mm:ss",
                "MMM d, yyyy, h:mm:ss a", // 예: Jan 1, 2023, 3:00:00 PM
                "MMM d, yyyy",            // 예: Jan 1, 2023
                "yyyy년 MM월 dd일 HH시 mm분",
                "yy.MM.dd HH:mm"
              ];

              for (const format of dateFormats) {
                try {
                  storyDate = parse(story.date_posted, format, new Date());
                  if (storyDate && !isNaN(storyDate.getTime())) break; // 성공하면 루프 종료
                } catch (e) { /* 다음 형식 시도 */ }
              }
              
              // parseISO도 시도 (ISO 형식 문자열 처리)
              if (!storyDate || isNaN(storyDate.getTime())) {
                try {
                  storyDate = parseISO(story.date_posted);
                } catch (e) { /* 실패 */ }
              }
            }

            if (storyDate && !isNaN(storyDate.getTime())) {
              const hoursDiff = differenceInHours(now, storyDate);
              const isRecent = hoursDiff >= 0 && hoursDiff <= timeframeHours;
              console.log(`"${story.headline}" - 날짜 "${story.date_posted}" (${storyDate.toISOString()})는 ${hoursDiff.toFixed(1)}시간 전. ${timeframeHours}시간 이내 여부: ${isRecent}`);
              return isRecent;
            } else {
              console.warn(`"${story.headline}" - 날짜 "${story.date_posted || '없음'}"을 파싱할 수 없거나 유효하지 않아 ${timeframeHours}시간 필터에서 제외.`);
              return false; // 날짜 파싱 불가 시 제외 (보수적 접근)
            }
          } catch (error) {
            console.error(`날짜 필터링 중 오류 발생 (스토리: "${story.headline}", 날짜: "${story.date_posted}"):`, error);
            return false; // 오류 발생 시 안전하게 제외
          }
        });
        
        // 필터링 결과 출력
        console.log(`${timeframeHours}시간 내 날짜 필터링: ${originalCount}개 중 ${allStories.length}개 남음`);
        
        // 필터링 후 남은 스토리 정보 로깅
        console.log(`=== 필터링 후 남은 스토리 ===`);
        allStories.forEach((story, idx) => {
          console.log(`${idx + 1}. "${story.headline}" - 날짜: ${story.date_posted || '날짜 없음'}`);
        });
        
        // 게시물이 없는 경우 처리 (수정된 부분) - 원본 데이터에서 최신 게시물 확인
        if (allStories.length === 0) {
          console.warn(`${timeframeHours}시간 내 게시물이 없습니다.`);
          
          // 원본 스토리 날짜 정보 출력
          const originalStories = [...results.flatMap(r => r.stories || [])];
          console.log(`=== 원본 스토리 날짜 정보 (${originalStories.length}개) ===`);
          originalStories.forEach((story, idx) => {
            if (idx < 10) { // 너무 많은 경우 앞의 10개만 로그
              console.log(`${idx + 1}. "${story.headline}" - 날짜: ${story.date_posted || '날짜 없음'}`);
            }
          });
          
          // 날짜 기준 내림차순 정렬 시도
          const sortedStories = [...originalStories].sort((a, b) => {
            try {
              // "days ago" 패턴을 비교하여 정렬
              const getDaysAgo = (dateStr: string) => {
                if (!dateStr) return Number.MAX_SAFE_INTEGER; // 날짜 없음 = 가장 오래됨
                
                const daysMatch = dateStr.match(/(\d+)\s*days?\s*ago/i);
                if (daysMatch) return parseInt(daysMatch[1]);
                
                const hoursMatch = dateStr.match(/(\d+)\s*(hour|hours)\s*ago/i);
                if (hoursMatch) return parseInt(hoursMatch[1]) / 24; // 시간을 일 단위로 변환
                
                const minsMatch = dateStr.match(/(\d+)\s*(minute|minutes|min|mins)\s*ago/i);
                if (minsMatch) return parseInt(minsMatch[1]) / (24 * 60); // 분을 일 단위로 변환
                
                // 기타 날짜 형식은 타임스탬프로 비교
                const dateA = new Date(dateStr);
                if (!isNaN(dateA.getTime())) {
                  return (now.getTime() - dateA.getTime()) / (24 * 60 * 60 * 1000); // 일 단위로 변환
                }
                
                return Number.MAX_SAFE_INTEGER; // 파싱 실패 = 가장 오래됨
              };
              
              const daysAgoA = getDaysAgo(a.date_posted);
              const daysAgoB = getDaysAgo(b.date_posted);
              
              return daysAgoA - daysAgoB; // 오름차순 (더 최근 = 더 작은 값)
            } catch (error) {
              return 0;
            }
          });
          
          // 가장 최근 게시물 확인
          if (sortedStories.length > 0) {
            const mostRecent = sortedStories[0];
            const mostRecentDate = mostRecent.date_posted || '날짜 정보 없음';
            
            console.log(`가장 최근 게시물: "${mostRecent.headline}" - 날짜: ${mostRecentDate}`);
            
            // 1일이 넘는 게시물인지 확인
            const daysAgoMatch = mostRecentDate.match(/(\d+)\s*days?\s*ago/i);
            if (daysAgoMatch) {
              const days = parseInt(daysAgoMatch[1]);
              if (days > 1) {
                console.warn(`가장 최근 게시물은 ${days}일 전 게시물입니다 (24시간 초과).`);
                console.warn(`최신 기사가 없으므로 빈 배열 반환 (24시간 정책 엄격 적용)`);
                // 24시간이 넘는 게시물은 포함하지 않음 - 엄격한 정책 적용
                return [];
              }
            }
            
            // 1일 이내 게시물이거나 날짜 확인 불가한 경우 최신 게시물 1개만 포함
            allStories = [mostRecent];
            console.log(`가장 최근 게시물 추가: ${mostRecent.headline}`);
          } else {
            console.warn(`사용 가능한 스토리가 없습니다.`);
          }
        }
      }
      
      // 최대 아이템 수 제한을 매우 엄격하게 적용
      if (allStories.length > maxItems) {
        console.log(`${allStories.length}개 스토리가 있어 최대 ${maxItems}개로 제한합니다.`);
        
        // 날짜 기준 정렬 시도
        allStories.sort((a, b) => {
          try {
            // 현재 시간 정의
            const now = new Date();
            
            // "days ago" 패턴으로 비교
            const getDaysAgo = (dateStr: string) => {
              if (!dateStr) return Number.MAX_SAFE_INTEGER;
              
              const daysMatch = dateStr.match(/(\d+)\s*days?\s*ago/i);
              if (daysMatch) return parseInt(daysMatch[1]);
              
              const hoursMatch = dateStr.match(/(\d+)\s*(hour|hours)\s*ago/i);
              if (hoursMatch) return parseInt(hoursMatch[1]) / 24;
              
              const minutesMatch = dateStr.match(/(\d+)\s*(minute|minutes|min|mins)\s*ago/i);
              if (minutesMatch) return parseInt(minutesMatch[1]) / (24 * 60);
              
              const dateObj = new Date(dateStr);
              if (!isNaN(dateObj.getTime())) {
                return (now.getTime() - dateObj.getTime()) / (24 * 60 * 60 * 1000);
              }
              
              return Number.MAX_SAFE_INTEGER;
            };
            
            return getDaysAgo(a.date_posted) - getDaysAgo(b.date_posted);
          } catch (error) {
            return 0;
          }
        });
        
        // 정렬 후 로깅
        console.log(`날짜순 정렬 후 스토리:`);
        allStories.forEach((story, idx) => {
          if (idx < maxItems) {
            console.log(`${idx + 1}. "${story.headline}" - 날짜: ${story.date_posted || '날짜 없음'}`);
          }
        });
        
        // 최신순으로 maxItems개만 선택
        allStories = allStories.slice(0, maxItems);
        console.log(`최종 선택된 ${maxItems}개 스토리: ${allStories.map(s => s.headline).join(', ')}`);
      }
      
      console.log(`크롤링 완료 (${source}): 최종 ${allStories.length}개의 스토리를 반환합니다.`);
      
      // 임시 파일 삭제
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {
        console.warn(`임시 파일 삭제 실패: ${outputPath}`);
      }
      
      return allStories;
    } else {
      throw new Error(`결과 파일을 찾을 수 없습니다: ${outputPath}`);
    }
  } catch (error) {
    console.error(`crawl4ai 서비스 오류 (${source}):`, error);
    
    // 에러 상세 정보 출력
    if (error instanceof Error && 'traceback' in error) {
      const pyError = error as PythonShellError;
      if (pyError.logs && pyError.logs.length > 0) {
        console.error('Python 오류 메시지:', pyError.logs.join('\n'));
      }
      if (pyError.traceback) {
        console.error('Python 스택 트레이스:', pyError.traceback);
      }
    }
    
    return [];
  }
}

/**
 * crawl4ai를 사용하여 여러 웹사이트를 크롤링합니다.
 * 각 소스마다 별도의 프로세스를 실행하여 순차적으로 처리합니다.
 * @param sources 크롤링할 소스 URL 목록
 * @param options 추가 옵션
 * @returns 크롤링 결과
 */
export async function crawlWebsites(
  sources: { identifier: string; maxItems?: number; timeframeHours?: number }[],
  options: {
    llmProvider?: 'openai' | 'together' | 'deepseek';
    outputPath?: string;
    batchDelay?: number;
    meta?: {
      targetDate?: string;
      contentFocus?: string;
      prioritizeRecent?: boolean;
      [key: string]: any;
    };
  } = {}
): Promise<Story[]> {
  try {
    // 순차적으로 각 소스를 개별적으로 처리
    const allStories: Story[] = [];
    const batchDelay = options.batchDelay || 10000; // 소스 간 대기 시간 (10초로 증가)
    
    console.log(`총 ${sources.length}개 소스를 순차적으로 처리합니다.`);
    console.log(`각 소스 사이 ${batchDelay}ms의 지연 시간 설정됨 (Rate Limit 방지)`);
    
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i].identifier;
      const maxItems = sources[i].maxItems || 1; // 기본값 1로 설정
      const timeframeHours = sources[i].timeframeHours || 36; // 기본값 36시간으로 설정
      
      console.log(`소스 처리 중 (${i+1}/${sources.length}): ${source}`);
      console.log(`설정: 최대 ${maxItems}개 항목, ${timeframeHours}시간 이내 필터링 적용`);
      
      try {
        // 각 소스를 독립적으로 크롤링
        const stories = await crawlSingleWebsite(source, {
          ...options,
          maxItems,
          timeframeHours
        });
        
        console.log(`소스 '${source}'에서 ${stories.length}개 스토리 찾음`);
        
        // 수집된 스토리의 날짜 정보 출력
        if (stories.length > 0) {
          console.log(`수집된 스토리 날짜 정보:`);
          stories.forEach((story, idx) => {
            console.log(`  ${idx + 1}. "${story.headline.substring(0, 50)}..." - 날짜: ${story.date_posted || '날짜 정보 없음'}`);
          });
        }
        
        // 결과 병합
        allStories.push(...stories);
        
        // 마지막 소스가 아니면 다음 소스 처리 전에 대기
        if (i < sources.length - 1) {
          console.log(`다음 소스 처리 전 ${batchDelay}ms 대기 (Rate Limit 방지)...`);
          await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
      } catch (sourceError) {
        console.error(`소스 크롤링 실패 (${source}): ${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
        console.log(`다음 소스로 진행합니다...`);
        
        // 오류가 발생해도 다음 소스 처리 전에 대기
        if (i < sources.length - 1) {
          console.log(`다음 소스 처리 전 ${batchDelay}ms 대기...`);
          await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
      }
    }
    
    console.log(`모든 소스 크롤링 완료: 총 ${allStories.length}개의 스토리를 찾았습니다.`);
    return allStories;
  } catch (error) {
    console.error('crawl4ai 서비스 오류:', error);
    return [];
  }
}

/**
 * crawl4ai 설치 여부를 확인합니다.
 * @returns 설치 여부
 */
export async function checkCrawl4aiInstallation(): Promise<boolean> {
  try {
    const checkScript = `
import sys
try:
    import crawl4ai
    print("installed", crawl4ai.__version__)
except ImportError:
    print("not_installed")
except Exception as e:
    print(f"error: {str(e)}")
    `;
    
    // 임시 스크립트 파일 생성
    const tempScriptPath = createTempPythonScript(checkScript);
    
    const options: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python', // python3 대신 python으로 변경
      pythonOptions: ['-u'] // 버퍼링 없이 출력 (유니코드 문제 해결)
    };
    
    try {
      const results = await PythonShell.run(tempScriptPath, options);
      // 임시 파일 삭제
      fs.unlinkSync(tempScriptPath);
      
      const result = results && results.length > 0 ? results[0] : '';
      const installed = result.includes('installed');
      
      if (installed) {
        console.log(`crawl4ai가 설치되어 있습니다. 버전: ${result.split(' ')[1] || '알 수 없음'}`);
      }
      
      return installed;
    } catch (error) {
      // 임시 파일 삭제 시도
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (e) {
        // 삭제 실패 무시
      }
      throw error;
    }
  } catch (error) {
    console.error('Python 확인 오류:', error);
    return false;
  }
}

/**
 * crawl4ai를 설치합니다.
 * @returns 설치 성공 여부
 */
export async function installCrawl4ai(): Promise<boolean> {
  try {
    // 설치 전 pip 업그레이드 및 설치 명령 개선
    const installScript = `
import sys
import subprocess
import os
import time

try:
    # 간단한 플래그 파일로 중복 설치 방지
    lock_file = os.path.join(os.path.expanduser('~'), '.crawl4ai_installing')
    
    # 이미 설치 중인지 확인
    if os.path.exists(lock_file):
        # 60초 이상 된 락 파일은 삭제 (이전 설치가 실패했을 수 있음)
        if os.path.getmtime(lock_file) < (time.time() - 60):
            os.remove(lock_file)
        else:
            # 이미 다른 프로세스에서 설치 중
            print("crawl4ai 설치가 이미 진행 중입니다")
            sys.exit(0)
    
    # 락 파일 생성
    with open(lock_file, 'w') as f:
        f.write(str(os.getpid()))
    
    try:
        # 먼저 pip 업그레이드
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip'])
        
        # 현재 디렉토리의 requirements.txt 파일 경로
        req_path = os.path.join('${process.cwd().replace(/\\/g, '\\\\')}', 'requirements.txt')
        
        if os.path.exists(req_path):
            # requirements.txt로 설치
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-r', req_path])
        else:
            # 직접 설치
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'crawl4ai'])
        
        # 설치 확인
        import crawl4ai
        print("success")
    finally:
        # 설치 완료 또는 실패 시 락 파일 제거
        if os.path.exists(lock_file):
            os.remove(lock_file)
except Exception as e:
    print(f"error: {str(e)}")
    sys.exit(1)
`;
    
    const tempScriptPath = createTempPythonScript(installScript);
    
    const options: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python'
    };
    
    console.log('crawl4ai 설치 중...');
    try {
      const results = await PythonShell.run(tempScriptPath, options);
      // 임시 파일 삭제
      fs.unlinkSync(tempScriptPath);
      
      const result = results && results.length > 0 ? results[0] : '';
      const success = result.includes('success');
      
      if (success) {
        console.log('crawl4ai 설치 완료!');
      } else {
        console.error('crawl4ai 설치 실패:', result);
      }
      
      return success;
    } catch (error) {
      // 임시 파일 삭제 시도
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (e) {
        // 삭제 실패 무시
      }
      throw error;
    }
  } catch (error) {
    console.error('crawl4ai 설치 오류:', error);
    return false;
  }
}

/**
 * 임베딩 기반 카테고리 분류를 위한 인터페이스
 */
export interface CategoryClassificationResult {
  category: string;
  confidence: number;
  subCategories?: string[];
  relatedTopics?: string[];
  keywordMatches?: { [keyword: string]: number };
}

/**
 * 임베딩을 통한 의미론적 텍스트 분석을 위한 Python 스크립트를 생성하고 실행
 * 
 * @param content 분석할 텍스트 콘텐츠
 * @param options 분석 옵션
 * @returns 분석 결과
 */
export async function analyzeContentWithEmbeddings(
  content: string,
  options: {
    llmProvider?: 'openai' | 'together' | 'deepseek';
    model?: string;
    categories?: string[];
  } = {}
): Promise<CategoryClassificationResult> {
  try {
    // 기본 카테고리 설정
    const defaultCategories = [
      '모델 업데이트', '연구 동향', '시장 동향', '개발자 도구',
      '산업 응용', '윤리 및 규제', '오픈 소스', '기초 연구'
    ];
    
    const categories = options.categories || defaultCategories;
    const llmProvider = options.llmProvider || 'openai';
    const model = options.model || 'gpt-4o-mini';
    
    // 인코딩 안전성을 위해 텍스트 전처리
    const safeContent = content
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // 제어 문자 제거
      .replace(/\\"/g, '"') // 이스케이프된 따옴표 정규화
      .replace(/\\\\/g, '\\') // 이스케이프된 백슬래시 정규화
      .normalize('NFKD') // 유니코드 정규화 (결합 문자 분해)
      .substring(0, 8000); // 길이 제한
    
    // 카테고리 리스트의 유효성 확인 및 ASCII 문자로 대체
    const safeCategories = categories.map(category => 
      category
        .normalize('NFKD') // 유니코드 정규화
        .replace(/[^\x00-\x7F]/g, '') // ASCII 문자가 아닌 것 제거
        .trim() || 'General' // 빈 문자열이면 General로 대체
    );
    
    // 중복 제거 및 유효한 카테고리만 필터링
    const uniqueCategories = [...new Set(safeCategories)].filter(Boolean);

    // 별도 Python 스크립트 경로
    const scriptPath = path.join(__dirname, '../scripts/analyze_content.py');
    
    // 스크립트가 없는 경우 오류 반환
    if (!fs.existsSync(scriptPath)) {
      console.error(`분석 스크립트를 찾을 수 없습니다: ${scriptPath}`);
      return {
        category: '연구 동향',
        confidence: 0.5
      };
    }
    
    // 환경 변수 설정
    const env = {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      TOGETHER_API_KEY: process.env.TOGETHER_API_KEY || '',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || ''
    };
    
    // Python 스크립트 옵션 - 인자로 데이터 전달
    const pythonOptions: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python',
      pythonOptions: ['-u'],
      args: [
        safeContent,
        JSON.stringify(uniqueCategories),
        llmProvider,
        model
      ],
      env
    };
    
    try {
      console.log('임베딩 기반 콘텐츠 분석 시작...');
      const results = await PythonShell.run(scriptPath, pythonOptions);
      
      if (results && results.length > 0) {
        try {
          const resultJson = JSON.parse(results[0]);
          
          // 에러 확인
          if (resultJson.error) {
            console.error('임베딩 분석 오류:', resultJson.error);
          }
          
          return {
            category: resultJson.category || '연구 동향',
            confidence: resultJson.confidence || 0.5,
            subCategories: resultJson.subCategories || [],
            relatedTopics: resultJson.relatedTopics || [],
            keywordMatches: resultJson.keywordMatches || {}
          };
        } catch (parseError) {
          console.error('결과 파싱 오류:', parseError, '원본 결과:', results[0].substring(0, 200));
          return {
            category: '연구 동향',
            confidence: 0.5
          };
        }
      }
      
      // 결과가 없는 경우 기본값 반환
      return {
        category: '연구 동향',
        confidence: 0.5
      };
    } catch (error) {
      console.error('임베딩 분석 실행 오류:', error);
      
      // 오류 발생 시 기본 카테고리 반환
      return {
        category: '연구 동향',
        confidence: 0.5
      };
    }
  } catch (error) {
    console.error('임베딩 분석 서비스 오류:', error);
    return {
      category: '연구 동향',
      confidence: 0.5
    };
  }
}

/**
 * 계층적 카테고리 분류를 위한 함수
 * 콘텐츠에 대해 메인 카테고리와 서브 카테고리를 동적으로 결정
 * 
 * @param content 분석할 콘텐츠 텍스트
 * @param options 분석 옵션
 * @returns 계층적 카테고리 분류 결과
 */
export async function classifyContentHierarchically(
  content: string,
  options: {
    mainCategories?: string[];
    llmProvider?: 'openai' | 'together' | 'deepseek';
    extractTopics?: boolean;
  } = {}
): Promise<{
  mainCategory: string;
  subCategories: string[];
  confidence: number;
  topics: string[];
}> {
  try {
    // 메인 카테고리 설정
    const mainCategories = options.mainCategories || [
      '모델 업데이트', '연구 동향', '시장 동향', '개발자 도구',
      '산업 응용', '윤리 및 규제', '오픈 소스', '기초 연구'
    ];
    
    // 임베딩 분석 수행
    const embeddingResult = await analyzeContentWithEmbeddings(content, {
      llmProvider: options.llmProvider,
      categories: mainCategories
    });
    
    // 토픽 추출 옵션
    const topics = embeddingResult.relatedTopics || [];
    
    return {
      mainCategory: embeddingResult.category,
      subCategories: embeddingResult.subCategories || [],
      confidence: embeddingResult.confidence,
      topics: options.extractTopics ? topics : []
    };
  } catch (error) {
    console.error('계층적 카테고리 분류 오류:', error);
    return {
      mainCategory: '연구 동향',
      subCategories: [],
      confidence: 0.5,
      topics: []
    };
  }
}

/**
 * Playwright를 사용한 동적 크롤링으로 웹사이트에서 링크를 찾아 콘텐츠를 추출합니다.
 * @param sources 크롤링할 소스 URL 목록
 * @param options 추가 옵션
 * @returns 크롤링 결과
 */
export async function dynamicCrawlWebsites(
  sources: { identifier: string; maxItems?: number; timeframeHours?: number }[],
  options: {
    llmProvider?: 'openai' | 'together' | 'deepseek';
    outputPath?: string;
    targetDate?: string;
    contentFocus?: string;
  } = {}
): Promise<Story[]> {
  try {
    // Python 스크립트가 기대하는 형태로 sources 배열 가공
    const sourcesConfigForPython = sources.map(s => ({
      identifier: s.identifier, // Python에서 'identifier' 또는 'url'로 조회
      maxItems: s.maxItems || 1,   // Python에서 'maxItems' 또는 'max_items'로 조회
    }));
    const sourcesConfigJson = JSON.stringify(sourcesConfigForPython);

    const scriptPath = path.join(__dirname, '../scripts/dynamic_crawl.py');
    const outputPath = options.outputPath || path.join(os.tmpdir(), `dynamic_crawl_result_${Date.now()}.json`);
    const llmProvider = options.llmProvider || 'openai';
    const targetDate = options.targetDate;
    const contentFocus = options.contentFocus;
    
    // 전체 크롤링 작업에 대한 timeframeHours 설정 (첫 번째 소스 또는 기본값 사용)
    const overallTimeframeHours = sources[0]?.timeframeHours || 48;

    if (!fs.existsSync(scriptPath)) {
      console.error(`Dynamic crawling 스크립트를 찾을 수 없습니다: ${scriptPath}`);
      throw new Error(`Dynamic crawling 스크립트가 존재하지 않습니다: ${scriptPath}`);
    }

    const pythonArgs: string[] = [
      '--sources_config', sourcesConfigJson,
      '--output', outputPath,
      '--llm_provider', llmProvider,
      '--timeframe_hours', overallTimeframeHours.toString(), // timeframe_hours 인자 전달
    ];

    if (targetDate) {
      pythonArgs.push('--target_date', targetDate);
    }
    if (contentFocus) {
      pythonArgs.push('--content_focus', contentFocus);
    }

    const pythonOptions: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python', // 시스템 PATH에 설정된 python 사용
      pythonOptions: ['-u'], // unbuffered stdout/stderr
      args: pythonArgs,
    };

    console.log(`Executing Dynamic Python script: ${scriptPath}`);
    console.log(`Python arguments:`);
    // 로그를 더 읽기 쉽게 출력 (한 줄로)
    console.log(JSON.stringify(pythonOptions.args, null, 2));
    
    console.log(`Dynamic crawl4ai 크롤링 시작 (Timeframe: ${overallTimeframeHours}h)...`);
    const resultsFromScript = await PythonShell.run(scriptPath, pythonOptions);

    if (resultsFromScript && resultsFromScript.length > 0) {
      console.log(`Dynamic Python script output (first 5 lines):`);
      resultsFromScript.slice(0, 5).forEach((line, i) => {
        console.log(`  ${i+1}. ${line.substring(0, 150)}${line.length > 150 ? '...' : ''}`);
      });
      if (resultsFromScript.length > 5) {
        console.log(`  ... and ${resultsFromScript.length - 5} more lines`);
      }
    }

    if (fs.existsSync(outputPath)) {
      const rawData = fs.readFileSync(outputPath, { encoding: 'utf-8' });
      const parsedResults: CrawlResult[] = JSON.parse(rawData); 
      
      let allStories: Story[] = [];
      for (const result of parsedResults) {
        if (result.stories && Array.isArray(result.stories)) {
          allStories.push(...result.stories);
        }
      }
      console.log(`🎉 동적 크롤링 완료: ${allStories.length}개 스토리 수집`); 
                 // 간소화된 결과 로깅 (소스 정보 포함)      if (allStories.length > 0) {        console.log(`📋 수집된 스토리 목록:`);        allStories.forEach((story, idx) => {          const source = (story as any).source || 'Unknown';          console.log(`   ${idx + 1}. "${story.headline}" (출처: ${source})`);        });      } else {        console.log(`⚠️ 수집된 스토리가 없습니다.`);      }

      return allStories;
    } else {
      console.error(`Dynamic crawl result file not found: ${outputPath}`);
      return [];
    }

  } catch (error: any) {
    console.error('Error during dynamic website crawling:', error);
    if (error.traceback) {
      console.error('Python Traceback:', error.traceback);
    }
    return [];
  }
} 