import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { z } from 'zod';

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
  } = {}
): Promise<Story[]> {
  try {
    const sourcesJson = JSON.stringify([source]);
    // 임시 디렉토리에 결과 파일 저장
    const outputPath = options.outputPath || path.join(os.tmpdir(), `crawl_result_${Date.now()}.json`);
    const llmProvider = options.llmProvider || 'openai';

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
        '--llm_provider', llmProvider
      ]
    };

    // 스크립트 실행
    console.log(`crawl4ai 크롤링 시작 (${source})...`);
    const results = await PythonShell.run(scriptPath, pythonOptions);
    
    // 결과 파일 읽기
    if (fs.existsSync(outputPath)) {
      const rawData = fs.readFileSync(outputPath, { encoding: 'utf-8' });
      const results: CrawlResult[] = JSON.parse(rawData);
      
      // 스토리 추출
      const allStories: Story[] = [];
      for (const result of results) {
        if (result.stories && Array.isArray(result.stories)) {
          allStories.push(...result.stories);
        }
      }
      
      console.log(`크롤링 완료 (${source}): ${allStories.length}개의 스토리를 찾았습니다.`);
      
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
  sources: { identifier: string }[],
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
    const batchDelay = options.batchDelay || 5000; // 소스 간 대기 시간 (기본 5초로 증가)
    
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i].identifier;
      console.log(`소스 처리 중 (${i+1}/${sources.length}): ${source}`);
      
      try {
        // 각 소스를 독립적으로 크롤링
        const stories = await crawlSingleWebsite(source, options);
        
        // 결과 병합
        allStories.push(...stories);
        
        // 마지막 소스가 아니면 다음 소스 처리 전에 대기
        if (i < sources.length - 1) {
          console.log(`다음 소스 처리 전 ${batchDelay}ms 대기...`);
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
  sources: { identifier: string }[],
  options: {
    llmProvider?: 'openai' | 'together' | 'deepseek';
    outputPath?: string;
    targetDate?: string;
    contentFocus?: string;
    maxLinksPerSource?: number;
  } = {}
): Promise<Story[]> {
  try {
    // 임시 디렉토리에 결과 파일 저장
    const outputPath = options.outputPath || path.join(os.tmpdir(), `dynamic_crawl_result_${Date.now()}.json`);
    const llmProvider = options.llmProvider || 'openai';
    const maxLinksPerSource = options.maxLinksPerSource || 5;

    // 소스 URL만 추출
    const sourceUrls = sources.map(source => source.identifier);
    const sourcesJson = JSON.stringify(sourceUrls);
    
    // Python 스크립트 경로
    const scriptPath = path.join(__dirname, '../scripts/dynamic_crawl.py');
    
    // 스크립트 존재 확인
    if (!fs.existsSync(scriptPath)) {
      console.error(`동적 크롤링 스크립트를 찾을 수 없습니다: ${scriptPath}`);
      throw new Error(`동적 크롤링 스크립트가 존재하지 않습니다: ${scriptPath}`);
    }

    // 명령줄 인자 구성
    const args = [
      '--sources', sourcesJson,
      '--output', outputPath,
      '--llm_provider', llmProvider
    ];

    // 선택적 인자 추가
    if (options.targetDate) {
      args.push('--target_date', options.targetDate);
    }
    
    if (options.contentFocus) {
      args.push('--content_focus', options.contentFocus);
    }

    // Python 스크립트 옵션
    const pythonOptions: PythonShellOptions = {
      mode: 'text',
      pythonPath: 'python',
      pythonOptions: ['-u'], // 버퍼링 없이 출력
      args: args
    };

    // Playwright 설치 필요 시
    try {
      // Playwright가 이미 설치되어 있는지 확인
      const checkScript = `
try:
    from playwright.async_api import async_playwright
    print("installed")
except ImportError:
    print("not_installed")
`;
      const tempScriptPath = createTempPythonScript(checkScript);
      const checkResult = await PythonShell.run(tempScriptPath, { 
        mode: 'text',
        pythonPath: 'python'
      });
      
      // 임시 파일 삭제
      try { fs.unlinkSync(tempScriptPath); } catch (e) { /* 무시 */ }
      
      // Playwright가 설치되어 있지 않으면 설치
      if (checkResult[0] !== "installed") {
        console.log("Playwright 설치 중...");
        // 별도의 스크립트 생성
        const installScript = `
import subprocess
import sys

# pip로 playwright 설치
subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
# playwright로 chromium 설치
subprocess.check_call([sys.executable, "-m", "playwright", "install", "chromium"])
print("playwright_installed")
`;
        const installScriptPath = createTempPythonScript(installScript);
        await PythonShell.run(installScriptPath, {
          mode: 'text',
          pythonPath: 'python'
        });
        
        // 임시 파일 삭제
        try { fs.unlinkSync(installScriptPath); } catch (e) { /* 무시 */ }
      }
    } catch (e: any) {
      console.error("Playwright 설치 오류:", e);
      throw new Error("Playwright 설치 실패: " + e.message);
    }

    // 스크립트 실행
    console.log(`동적 크롤링 시작 (${sourceUrls.length}개 소스)...`);
    const results = await PythonShell.run(scriptPath, pythonOptions);
    console.log('동적 크롤링 프로세스 완료');
    
    // 결과 파일 읽기
    if (fs.existsSync(outputPath)) {
      const rawData = fs.readFileSync(outputPath, { encoding: 'utf-8' });
      const results: CrawlResult[] = JSON.parse(rawData);
      
      // 스토리 추출
      const allStories: Story[] = [];
      for (const result of results) {
        if (result.stories && Array.isArray(result.stories)) {
          allStories.push(...result.stories);
        }
      }
      
      console.log(`동적 크롤링 완료: ${allStories.length}개의 스토리를 찾았습니다.`);
      
      // 임시 파일 삭제
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {
        console.warn(`임시 파일 삭제 실패: ${outputPath}`);
      }
      
      return allStories;
    } else {
      throw new Error(`동적 크롤링 결과 파일을 찾을 수 없습니다: ${outputPath}`);
    }
  } catch (error) {
    console.error('동적 크롤링 서비스 오류:', error);
    return [];
  }
} 