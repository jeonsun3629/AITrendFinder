import asyncio
import json
import os
import sys
import time
import re
from datetime import datetime
from typing import List, Dict, Any, Optional, Union

# 필요한 라이브러리 동적 설치
def ensure_installed(package: str) -> None:
    try:
        __import__(package)
    except ImportError:
        import subprocess
        print(f"Installing {package}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

# 필요한 패키지 설치
ensure_installed("playwright")
ensure_installed("beautifulsoup4")
ensure_installed("openai")

# 설치 후 임포트
from playwright.async_api import async_playwright, Page, Browser, BrowserContext
from bs4 import BeautifulSoup
import openai

# OpenAI API 키 설정
openai.api_key = os.environ.get("OPENAI_API_KEY", "")

# 스토리 인터페이스 정의
class Story:
    def __init__(self):
        self.headline = ""
        self.link = ""
        self.date_posted = ""
        self.fullContent = ""
        self.imageUrls = []
        self.videoUrls = []
        self.popularity = ""
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "headline": self.headline,
            "link": self.link,
            "date_posted": self.date_posted,
            "fullContent": self.fullContent,
            "imageUrls": self.imageUrls,
            "videoUrls": self.videoUrls,
            "popularity": self.popularity
        }

# 크롤링 결과 클래스
class CrawlResult:
    def __init__(self, source: str):
        self.source = source
        self.stories = []
        self.error = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "stories": [story.to_dict() for story in self.stories],
            "error": self.error
        }

# 날짜 파싱 함수 - 다양한 형식 처리
def parse_date(date_str: str) -> str:
    try:
        # 현재 날짜 생성
        if not date_str or date_str.lower() in ['today', '오늘']:
            return datetime.now().strftime('%Y-%m-%d')
        
        # 다양한 날짜 형식 처리 시도
        formats = [
            '%Y-%m-%d', '%Y/%m/%d', '%d-%m-%Y', '%d/%m/%Y',
            '%b %d, %Y', '%B %d, %Y', '%d %b %Y', '%d %B %Y',
            '%Y년 %m월 %d일', '%Y. %m. %d.'
        ]
        
        for fmt in formats:
            try:
                date_obj = datetime.strptime(date_str, fmt)
                return date_obj.strftime('%Y-%m-%d')
            except ValueError:
                continue
        
        # 상대적 날짜 표현 처리 (예: "3일 전", "2시간 전")
        if '전' in date_str:
            # 간단한 처리를 위해 오늘 날짜 반환
            return datetime.now().strftime('%Y-%m-%d')
        
        # 파싱 실패 시 원본 반환
        return date_str
    except Exception as e:
        print(f"날짜 파싱 오류: {str(e)}")
        return date_str

# 현재 날짜에 관련된 콘텐츠인지 확인
def is_relevant_date(date_str: str, target_date: Optional[str] = None) -> bool:
    if not target_date:
        return True
    
    try:
        parsed_date = parse_date(date_str)
        target = datetime.strptime(target_date, '%Y-%m-%d').date()
        content_date = datetime.strptime(parsed_date, '%Y-%m-%d').date()
        
        # 대상 날짜 또는 그 이후의 콘텐츠만 포함
        return content_date >= target
    except:
        # 날짜 비교 실패 시 포함 (안전성)
        return True

# Playwright를 사용한 동적 크롤링 클래스
class DynamicCrawler:
    def __init__(self, 
                 llm_provider: str = 'openai', 
                 headless: bool = True, 
                 target_date: Optional[str] = None):
        self.llm_provider = llm_provider
        self.headless = headless
        self.target_date = target_date
        self.browser = None
        self.context = None
    
    async def initialize(self):
        """브라우저 초기화"""
        try:
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.launch(headless=self.headless)
            self.context = await self.browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            )
        except Exception as e:
            print(f"브라우저 초기화 오류: {str(e)}")
            raise
    
    async def close(self):
        """리소스 정리"""
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if hasattr(self, 'playwright'):
            await self.playwright.stop()
    
    async def analyze_page_structure(self, page: Page, url: str) -> Dict[str, Any]:
        """페이지 구조 분석: 관련 링크와 콘텐츠 구조를 식별"""
        try:
            # 페이지 내 링크 분석
            links = await page.evaluate('''() => {
                const links = Array.from(document.querySelectorAll('a'));
                return links.map(link => {
                    return {
                        href: link.href,
                        text: link.innerText.trim(),
                        classes: link.className,
                        id: link.id,
                        rect: link.getBoundingClientRect()
                    };
                }).filter(link => link.href && link.href.startsWith('http'));
            }''')
            
            # 페이지 콘텐츠 구조 분석
            structure = await page.evaluate('''() => {
                // 메인 콘텐츠 영역 찾기 시도
                const possibleContentSelectors = [
                    'article', 'main', '.article', '.content', '.post', 
                    '#article', '#content', '#post', '[role="main"]',
                    '.entry-content', '.post-content', '.article-content'
                ];
                
                for (const selector of possibleContentSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        return {
                            contentSelector: selector,
                            hasContent: true
                        };
                    }
                }
                
                return {
                    contentSelector: null,
                    hasContent: false
                };
            }''')
            
            return {
                'url': url,
                'links': links,
                'structure': structure
            }
        except Exception as e:
            print(f"페이지 구조 분석 오류: {str(e)}")
            return {'url': url, 'links': [], 'structure': {'contentSelector': None, 'hasContent': False}}
    
    async def filter_relevant_links(self, links: List[Dict[str, Any]], content_focus: Optional[str] = None) -> List[Dict[str, Any]]:
        """관련성 있는 링크만 필터링"""
        if not content_focus:
            # 필터 없이 처음 10개 링크만 반환
            return links[:10]
        
        # 콘텐츠 관련성 기준으로 필터링
        relevant_keywords = content_focus.lower().split()
        scored_links = []
        
        for link in links:
            score = 0
            text = link.get('text', '').lower()
            href = link.get('href', '').lower()
            
            # 키워드 매칭 점수 계산
            for keyword in relevant_keywords:
                if keyword in text:
                    score += 2
                if keyword in href:
                    score += 1
            
            if score > 0:
                scored_links.append((link, score))
        
        # 점수 기준 내림차순 정렬 후 상위 10개만 반환
        scored_links.sort(key=lambda x: x[1], reverse=True)
        return [link for link, _ in scored_links[:10]]
    
    async def extract_content(self, page: Page, structure: Dict[str, Any]) -> Dict[str, Any]:
        """페이지에서 주요 콘텐츠 추출"""
        try:
            content_selector = structure.get('contentSelector')
            
            # 선택자가 있으면 해당 영역에서 추출, 없으면 전체 페이지에서 추출
            content_html = await page.evaluate(f'''() => {{
                if ('{content_selector}') {{
                    const elements = document.querySelectorAll('{content_selector}');
                    if (elements.length > 0) {{
                        return elements[0].innerHTML;
                    }}
                }}
                // 선택자가 없는 경우 body 전체 콘텐츠 반환
                return document.body.innerHTML;
            }}''')
            
            # BeautifulSoup으로 HTML 파싱
            soup = BeautifulSoup(content_html, 'html.parser')
            
            # 불필요한 요소 제거
            for tag in soup.select('script, style, nav, footer, .nav, .footer, .menu, .sidebar, .comments, .related, .advertisement'):
                tag.decompose()
            
            # 이미지 URL 추출
            image_urls = [img.get('src') for img in soup.select('img') if img.get('src')]
            image_urls = [url if url.startswith('http') else f"https://{url}" if url.startswith('//') else url for url in image_urls]
            
            # 비디오 URL 추출
            video_urls = [video.get('src') for video in soup.select('video source, iframe') if video.get('src')]
            
            # 날짜 추출 시도
            date_text = ''
            date_selectors = [
                'time', '.date', '.time', '.published', '.post-date', '.article-date',
                'meta[property="article:published_time"]', 'meta[name="date"]'
            ]
            
            for selector in date_selectors:
                date_element = soup.select_one(selector)
                if date_element:
                    if date_element.name == 'meta':
                        date_text = date_element.get('content', '')
                    else:
                        date_text = date_element.text.strip()
                    if date_text:
                        break
            
            # 텍스트 콘텐츠 정리
            text_content = soup.get_text(separator='\n').strip()
            text_content = re.sub(r'\n{3,}', '\n\n', text_content)  # 과도한 개행 제거
            
            return {
                'text': text_content,
                'html': str(soup),
                'images': image_urls,
                'videos': video_urls,
                'date': parse_date(date_text)
            }
        except Exception as e:
            print(f"콘텐츠 추출 오류: {str(e)}")
            return {'text': '', 'html': '', 'images': [], 'videos': [], 'date': ''}
    
    async def extract_headline(self, page: Page) -> str:
        """페이지에서 제목 추출"""
        try:
            return await page.evaluate('''() => {
                const h1 = document.querySelector('h1');
                if (h1) {
                    return h1.innerText.trim();
                }
                
                const title = document.querySelector('title');
                if (title) {
                    return title.innerText.trim();
                }
                
                return '';
            }''')
        except Exception as e:
            print(f"제목 추출 오류: {str(e)}")
            return ""
    
    async def crawl_url(self, url: str, content_focus: Optional[str] = None, max_links: int = 5) -> CrawlResult:
        """단일 URL을 크롤링하고 관련 링크를 탐색"""
        result = CrawlResult(url)
        
        try:
            # 새 페이지 생성
            page = await self.context.new_page()
            
            # 기본 URL 방문
            print(f"기본 URL 방문: {url}")
            await page.goto(url, wait_until='networkidle', timeout=60000)
            await page.wait_for_timeout(2000)  # 페이지 렌더링 대기
            
            # 페이지 구조 분석
            structure = await self.analyze_page_structure(page, url)
            
            # 관련 링크 필터링
            links = await self.filter_relevant_links(structure['links'], content_focus)
            
            # 최대 링크 수 제한
            links = links[:min(len(links), max_links)]
            
            print(f"찾은 관련 링크 수: {len(links)}")
            
            # 각 링크 방문하여 콘텐츠 추출
            for i, link in enumerate(links):
                link_url = link.get('href')
                if not link_url:
                    continue
                
                try:
                    print(f"링크 방문 ({i+1}/{len(links)}): {link_url}")
                    
                    # 새 페이지에서 링크 열기
                    link_page = await self.context.new_page()
                    await link_page.goto(link_url, wait_until='networkidle', timeout=60000)
                    await link_page.wait_for_timeout(2000)
                    
                    # 링크 페이지 구조 분석
                    link_structure = await self.analyze_page_structure(link_page, link_url)
                    
                    # 콘텐츠 추출
                    content = await self.extract_content(link_page, link_structure['structure'])
                    headline = await self.extract_headline(link_page)
                    
                    # 날짜 관련성 확인
                    if self.target_date and not is_relevant_date(content['date'], self.target_date):
                        print(f"날짜 필터링: {content['date']} < {self.target_date}")
                        await link_page.close()
                        continue
                    
                    # 결과 저장
                    story = Story()
                    story.headline = headline or link.get('text', '제목 없음')
                    story.link = link_url
                    story.date_posted = content['date']
                    story.fullContent = content['text']
                    story.imageUrls = content['images']
                    story.videoUrls = content['videos']
                    
                    result.stories.append(story)
                    print(f"콘텐츠 추출 완료: {story.headline}")
                    
                    # 페이지 닫기
                    await link_page.close()
                    
                    # 서버 부하 방지 대기
                    await asyncio.sleep(2)
                    
                except Exception as e:
                    print(f"링크 처리 오류 ({link_url}): {str(e)}")
                    # 다음 링크로 계속 진행
            
            # 메인 페이지 닫기
            await page.close()
            
        except Exception as e:
            result.error = str(e)
            print(f"크롤링 오류 ({url}): {str(e)}")
        
        return result

async def main():
    try:
        # 명령줄 인자 처리
        if len(sys.argv) < 2:
            print("사용법: python dynamic_crawl.py [--sources 소스URL들] [--output 출력파일경로] [--llm_provider provider] [--target_date YYYY-MM-DD] [--content_focus 주제]")
            sys.exit(1)
        
        # 인자 파싱
        sources_json = None
        output_path = "crawl_results.json"
        llm_provider = "openai"
        target_date = None
        content_focus = None
        
        i = 1
        while i < len(sys.argv):
            if sys.argv[i] == "--sources":
                sources_json = sys.argv[i+1]
                i += 2
            elif sys.argv[i] == "--output":
                output_path = sys.argv[i+1]
                i += 2
            elif sys.argv[i] == "--llm_provider":
                llm_provider = sys.argv[i+1]
                i += 2
            elif sys.argv[i] == "--target_date":
                target_date = sys.argv[i+1]
                i += 2
            elif sys.argv[i] == "--content_focus":
                content_focus = sys.argv[i+1]
                i += 2
            else:
                i += 1
        
        # 소스 URL 파싱
        sources = json.loads(sources_json)
        
        # 동적 크롤러 초기화
        crawler = DynamicCrawler(
            llm_provider=llm_provider,
            headless=True,  # 헤드리스 모드 활성화
            target_date=target_date
        )
        
        await crawler.initialize()
        
        # 각 소스 처리
        results = []
        for source in sources:
            print(f"소스 처리 중: {source}")
            result = await crawler.crawl_url(
                url=source,
                content_focus=content_focus,
                max_links=5  # 최대 5개 관련 링크 처리
            )
            results.append(result.to_dict())
        
        # 크롤러 종료
        await crawler.close()
        
        # 결과 저장
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        
        print(f"크롤링 완료: {output_path}에 저장됨")
        
    except Exception as e:
        print(f"오류 발생: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main()) 