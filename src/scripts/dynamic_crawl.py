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

# 날짜 관련성 확인 - 24시간 이내의 기사만 포함하도록 엄격하게 제한
def is_relevant_date(date_str: str, target_date: Optional[str] = None) -> bool:
    if not target_date:
        return True
    
    try:
        # 현재 시간 기준 (target_date가 제공되지 않은 경우)
        now = datetime.now()
        
        # target_date가 제공된 경우 해당 날짜 사용
        if target_date:
            target = datetime.strptime(target_date, '%Y-%m-%d').date()
            # 타겟 날짜가 오늘보다 이전이면 target ~ 현재 사이의 콘텐츠만 포함
            if target.toordinal() < now.date().toordinal():
                start_date = target
                end_date = now.date()
            else:
                # 타겟 날짜가 미래인 경우 현재 ~ target 사이의 콘텐츠만 포함
                start_date = now.date()
                end_date = target
                
            print(f"날짜 필터링 기준: {start_date} ~ {end_date} (24시간 이내)")
        
        # "X days ago" 패턴 직접 처리
        days_ago_match = re.search(r'(\d+)\s*days?\s*ago', date_str, re.IGNORECASE)
        if days_ago_match:
            days = int(days_ago_match.group(1))
            print(f"날짜 '{date_str}'는 {days}일 전으로 파싱됨")
            # 24시간(1일) 이내만 허용
            return days <= 1
        
        # "yesterday" 처리
        if re.search(r'yesterday|어제', date_str, re.IGNORECASE):
            print(f"날짜 '{date_str}'는 어제로 파싱됨 (24시간 이내)")
            return True
        
        # "X hours/minutes ago" 패턴 처리
        time_ago_match = re.search(r'(\d+)\s*(hour|hours|minute|minutes|min|mins)\s*ago', date_str, re.IGNORECASE)
        if time_ago_match:
            amount = int(time_ago_match.group(1))
            unit = time_ago_match.group(2).lower()
            
            if 'hour' in unit:
                # 24시간 이내만 허용
                is_recent = amount <= 24
                print(f"날짜 '{date_str}'는 {amount}시간 전으로 파싱됨 - {'최근' if is_recent else '24시간 초과'}")
                return is_recent
            elif 'min' in unit or 'minute' in unit:
                # 분 단위는 항상 최근
                print(f"날짜 '{date_str}'는 {amount}분 전으로 파싱됨 (최근)")
                return True
        
        # 일반 날짜 형식 처리
        parsed_date = parse_date(date_str)
        try:
            content_date = datetime.strptime(parsed_date, '%Y-%m-%d').date()
            
            # 오늘 또는 어제인지 확인 (24시간 이내)
            delta = now.date() - content_date
            
            # 24시간(1일) 이내만 허용 - 엄격하게 적용
            is_recent = delta.days <= 1
            print(f"날짜 '{date_str}'는 {delta.days}일 전으로 파싱됨 - {'최근' if is_recent else '24시간 초과'}")
            return is_recent
            
        except Exception as e:
            print(f"날짜 파싱 오류 ({date_str}): {e}")
            # 날짜 파싱 오류 시 false 반환 (안전하게)
            return False
            
    except Exception as e:
        print(f"날짜 비교 오류 ({date_str}): {e}")
        # 오류 발생 시 false 반환 (안전하게)
        return False

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
                
                // 선택자가 없는 경우 메인 콘텐츠 영역 추정
                const articleSelectors = [
                    'article', 'main', '.article', '.content', '.post', 
                    '#article', '#content', '#post', '[role="main"]',
                    '.entry-content', '.post-content', '.article-content'
                ];
                
                for (const selector of articleSelectors) {{
                    const element = document.querySelector(selector);
                    if (element) {{
                        return element.innerHTML;
                    }}
                }}
                
                // 여전히 못 찾은 경우 body 전체 콘텐츠 반환
                return document.body.innerHTML;
            }}''')
            
            # BeautifulSoup으로 HTML 파싱
            soup = BeautifulSoup(content_html, 'html.parser')
            
            # 불필요한 요소 제거
            for tag in soup.select('script, style, nav, footer, header, .nav, .footer, .menu, .sidebar, .comments, .related, .advertisement, .author, .profile, .avatar, .bio, .social-media, .share, .likes'):
                tag.decompose()
            
            # 1. 본문 이미지 URL 추출 - 프로필 이미지, 아이콘, 로고 등 제외
            image_urls = []
            
            # 1.1 본문 영역에서 큰 이미지만 선택 (작은 이미지는 아이콘일 가능성 높음)
            for img in soup.select('img'):
                src = img.get('src')
                if not src:
                    continue
                
                # 이미지 URL 정규화
                if src.startswith('//'):
                    src = f"https:{src}"
                elif not src.startswith(('http://', 'https://')):
                    # 상대 경로인 경우 절대 경로로 변환 시도
                    if src.startswith('/'):
                        # 도메인 추출 시도
                        domain_match = re.match(r'(https?://[^/]+)', page.url)
                        if domain_match:
                            src = f"{domain_match.group(1)}{src}"
                
                # 이미지 크기 속성 확인 (작은 이미지 필터링)
                width = img.get('width')
                height = img.get('height')
                try:
                    # 크기가 명시적으로 작은 이미지 제외
                    if width and int(width) < 100:
                        continue
                    if height and int(height) < 100:
                        continue
                except (ValueError, TypeError):
                    pass
                
                # 이미지 클래스와 ID 기반 필터링
                img_class = img.get('class', [])
                img_id = img.get('id', '')
                img_alt = img.get('alt', '').lower()
                
                # 프로필, 아이콘, 로고 등 제외 키워드
                excluded_keywords = ['profile', 'avatar', 'logo', 'icon', 'thumbnail', 'badge', 
                                   'banner', 'author', 'user', 'favicon', 'menu', 'nav']
                
                # 클래스, ID, alt 텍스트에 제외 키워드가 있는지 확인
                skip = False
                for keyword in excluded_keywords:
                    if ((isinstance(img_class, list) and any(keyword in c.lower() for c in img_class)) or
                        (isinstance(img_class, str) and keyword in img_class.lower()) or
                        keyword in img_id.lower() or 
                        keyword in img_alt):
                        skip = True
                        break
                
                if skip:
                    continue
                
                # 본문 이미지로 판단되면 추가
                image_urls.append(src)
            
            # 2. 본문 비디오 URL 추출 - 배너, 광고 등 제외
            video_urls = []
            
            # 2.1 iframe 비디오 (YouTube, Vimeo 등)
            for iframe in soup.select('iframe'):
                src = iframe.get('src')
                if not src:
                    continue
                
                # 일반적인 비디오 서비스 도메인 확인
                video_domains = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 
                                'player.twitch.tv', 'ted.com', 'metacafe.com', 'wistia.com']
                
                if any(domain in src.lower() for domain in video_domains):
                    video_urls.append(src)
            
            # 2.2 video 태그
            for video in soup.select('video'):
                # video 태그 자체에 src가 있는 경우
                src = video.get('src')
                if src:
                    video_urls.append(src)
                
                # source 태그가 있는 경우
                for source in video.select('source'):
                    src = source.get('src')
                    if src:
                        video_urls.append(src)
            
            # URL 정규화 및 중복 제거
            image_urls = list(set([url if url.startswith('http') else url for url in image_urls if url]))
            video_urls = list(set([url if url.startswith('http') else url for url in video_urls if url]))
            
            print(f"추출된 본문 이미지: {len(image_urls)}개, 비디오: {len(video_urls)}개")
            
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
    
    async def crawl_url(self, url: str, content_focus: Optional[str] = None, max_links: int = 1) -> CrawlResult:
        """단일 URL을 크롤링하고 관련 링크를 탐색 - 최대 링크 수를 1로 기본 설정"""
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
                    
                    # 날짜 관련성 확인 - 24시간 필터링 엄격하게 적용
                    date_is_relevant = is_relevant_date(content['date'], self.target_date)
                    if not date_is_relevant:
                        print(f"⚠️ 날짜 필터링: {content['date']} (24시간 초과)")
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
                max_links=1  # 강제로 1개로 제한
            )
            results.append(result.to_dict())
            
            # 소스 사이에 지연 추가
            if source != sources[-1]:
                delay = 5  # 5초 지연
                print(f"다음 소스 처리 전 {delay}초 대기...")
                await asyncio.sleep(delay)
        
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