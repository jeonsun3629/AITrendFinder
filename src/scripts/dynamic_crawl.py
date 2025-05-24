import asyncio
import json
import os
import sys
import time
import re
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional, Union
import argparse
import urllib.parse # URL 정규화를 위해 추가

# Windows에서 유니코드 출력을 위한 설정
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

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
ensure_installed("python-dateutil")

# 설치 후 임포트
from playwright.async_api import async_playwright, Page, Browser, BrowserContext
from bs4 import BeautifulSoup
import openai
from dateutil import parser as date_parser

# 사이트 설정 시스템 임포트
# from site_configs import site_config_manager, SiteConfig

# OpenAI API 키 설정
openai.api_key = os.environ.get("OPENAI_API_KEY", "")

# JSON 설정 로더
class JSONConfigLoader:
    """JSON 파일에서 사이트 설정을 로드하는 클래스"""
    
    @staticmethod
    def load_config_from_json(json_path: str = "site_configs.json"):
        """JSON 파일에서 사이트 설정을 로드하여 site_config_manager에 추가"""
        print("⚠️ 간소화된 버전: JSON 설정 로더 비활성화됨")
        return

# 향상된 사이트 감지 클래스
class SiteDetector:
    """웹사이트의 유형과 구조를 자동으로 감지하는 클래스"""
    
    @staticmethod
    async def detect_site_type(page: Page) -> Dict[str, Any]:
        """페이지를 분석하여 사이트 유형과 특성을 감지"""
        try:
            detection_result = await page.evaluate(r'''() => {
                const result = {
                    platform: 'unknown',
                    cms: 'unknown',
                    structure: 'unknown',
                    features: [],
                    meta_info: {},
                    selectors: {
                        articles: [],
                        content: [],
                        dates: []
                    }
                };
                
                // HTML과 head 정보 분석
                const html = document.documentElement.outerHTML.toLowerCase();
                const headContent = document.head ? document.head.innerHTML.toLowerCase() : '';
                
                // CMS 감지
                if (html.includes('wp-content') || html.includes('wordpress') || html.includes('/wp-includes/')) {
                    result.cms = 'wordpress';
                    result.platform = 'blog';
                } else if (html.includes('medium-feed') || window.location.hostname.includes('medium')) {
                    result.cms = 'medium';
                    result.platform = 'blog';
                } else if (html.includes('reddit') || window.location.hostname.includes('reddit')) {
                    result.cms = 'reddit';
                    result.platform = 'social';
                } else if (html.includes('ghost') || document.querySelector('meta[name="generator"][content*="Ghost"]')) {
                    result.cms = 'ghost';
                    result.platform = 'blog';
                } else if (html.includes('drupal') || document.querySelector('meta[name="generator"][content*="Drupal"]')) {
                    result.cms = 'drupal';
                    result.platform = 'news';
                }
                
                // 플랫폼 유형 감지
                const titleAndMeta = (document.title + ' ' + headContent).toLowerCase();
                if (titleAndMeta.includes('news') || titleAndMeta.includes('journal') || titleAndMeta.includes('press')) {
                    result.platform = 'news';
                } else if (titleAndMeta.includes('blog') || titleAndMeta.includes('diary')) {
                    result.platform = 'blog';
                } else if (titleAndMeta.includes('forum') || titleAndMeta.includes('community')) {
                    result.platform = 'forum';
                }
                
                // 구조 분석
                const hasArticleTag = document.querySelectorAll('article').length > 0;
                const hasMainTag = document.querySelectorAll('main').length > 0;
                const hasPostClass = document.querySelectorAll('[class*="post"]').length > 0;
                const hasNewsClass = document.querySelectorAll('[class*="news"]').length > 0;
                
                if (hasArticleTag) {
                    result.structure = 'semantic';
                    result.features.push('html5-semantic');
                } else if (hasPostClass || hasNewsClass) {
                    result.structure = 'content-based';
                }
                
                // 동적 선택자 생성
                const potentialArticleSelectors = [];
                const potentialContentSelectors = [];
                const potentialDateSelectors = [];
                
                // 기사 링크가 있을 만한 요소들 찾기
                const linkContainers = ['article', 'h1', 'h2', 'h3', '.post', '.news', '.story', '.entry', '.item'];
                linkContainers.forEach(selector => {
                    try {
                        const elements = document.querySelectorAll(selector + ' a');
                        if (elements.length > 0) {
                            potentialArticleSelectors.push(selector + ' a');
                        }
                    } catch (e) {}
                });
                
                // 클래스 기반 선택자 생성
                const classPatterns = ['title', 'headline', 'post', 'article', 'news', 'story', 'entry'];
                classPatterns.forEach(pattern => {
                    try {
                        const classSelector = '.' + pattern + ' a';
                        if (document.querySelectorAll(classSelector).length > 0) {
                            potentialArticleSelectors.push(classSelector);
                        }
                        const classOnlySelector = '.' + pattern + '-title a';
                        if (document.querySelectorAll(classOnlySelector).length > 0) {
                            potentialArticleSelectors.push(classOnlySelector);
                        }
                    } catch (e) {}
                });
                
                // 콘텐츠 선택자 생성
                const contentContainers = ['article', 'main', '.content', '.post-content', '.entry-content', '.article-body'];
                contentContainers.forEach(selector => {
                    try {
                        if (document.querySelectorAll(selector).length > 0) {
                            potentialContentSelectors.push(selector);
                        }
                    } catch (e) {}
                });
                
                // 날짜 선택자 생성
                const dateContainers = ['time', '.date', '.published', '.timestamp', '.post-date', '.entry-date'];
                dateContainers.forEach(selector => {
                    try {
                        if (document.querySelectorAll(selector).length > 0) {
                            potentialDateSelectors.push(selector);
                        }
                    } catch (e) {}
                });
                
                result.selectors.articles = potentialArticleSelectors;
                result.selectors.content = potentialContentSelectors;
                result.selectors.dates = potentialDateSelectors;
                
                // 메타 정보 수집
                const ogSiteName = document.querySelector('meta[property="og:site_name"]');
                if (ogSiteName) result.meta_info.site_name = ogSiteName.content;
                
                const generator = document.querySelector('meta[name="generator"]');
                if (generator) result.meta_info.generator = generator.content;
                
                return result;
            }''')
            
            print(f"사이트 감지 결과: {detection_result['platform']}/{detection_result['cms']}")
            return detection_result
            
        except Exception as e:
            print(f"사이트 감지 오류: {e}")
            return {'platform': 'unknown', 'cms': 'unknown', 'structure': 'unknown', 'features': [], 'selectors': {'articles': [], 'content': [], 'dates': []}}

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
        self.summary = ""  # 요약 추가
        self.tags = []     # 태그 추가
        self.source = ""   # 소스 사이트 추가
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "headline": self.headline,
            "link": self.link,
            "date_posted": self.date_posted,
            "fullContent": self.fullContent,
            "imageUrls": self.imageUrls,
            "videoUrls": self.videoUrls,
            "popularity": self.popularity,
            "summary": self.summary,
            "tags": self.tags,
            "source": self.source
        }

# 크롤링 결과 클래스
class CrawlResult:
    def __init__(self, source: str):
        self.source = source
        self.stories = []
        self.error = None
        self.site_info = {}  # 사이트 정보 추가
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "stories": [story.to_dict() for story in self.stories],
            "error": self.error,
            "site_info": self.site_info
        }

# 향상된 날짜 파싱 함수
def parse_date(date_str: str) -> str:
    if not date_str:
        return ""

    original_date_str = date_str.strip()
    now = datetime.now()

    # 1. "오늘", "Today", "just now" 처리
    today_patterns = ['today', '오늘', 'just now', 'now', 'a moment ago', '방금', '지금']
    if any(pattern in original_date_str.lower() for pattern in today_patterns):
        return now.strftime('%Y-%m-%d')

    # 2. "어제", "Yesterday" 처리
    yesterday_patterns = ['yesterday', '어제']
    if any(pattern in original_date_str.lower() for pattern in yesterday_patterns):
        yesterday = now - timedelta(days=1)
        return yesterday.strftime('%Y-%m-%d')

    # 3. 상대적 시간 표현 처리 (더 많은 패턴)
    relative_patterns = [
        (r'(\d+)\s*(초|second)s?\s*(전|ago)', 'seconds'),
        (r'(\d+)\s*(분|minute|min)s?\s*(전|ago)', 'minutes'),
        (r'(\d+)\s*(시간|hour|hr)s?\s*(전|ago)', 'hours'),
        (r'(\d+)\s*(일|day)s?\s*(전|ago)', 'days'),
        (r'(\d+)\s*(주|week)s?\s*(전|ago)', 'weeks'),
        (r'(\d+)\s*(달|month)s?\s*(전|ago)', 'months'),
        (r'(\d+)\s*(년|year)s?\s*(전|ago)', 'years'),
    ]
    
    for pattern, unit in relative_patterns:
        match = re.search(pattern, original_date_str, re.IGNORECASE)
        if match:
            value = int(match.group(1))
            
            if unit == 'seconds':
                target_date = now - timedelta(seconds=value)
            elif unit == 'minutes':
                target_date = now - timedelta(minutes=value)
            elif unit == 'hours':
                target_date = now - timedelta(hours=value)
            elif unit == 'days':
                target_date = now - timedelta(days=value)
            elif unit == 'weeks':
                target_date = now - timedelta(weeks=value)
            elif unit == 'months':
                # 월 계산 (근사치)
                target_date = now - timedelta(days=value * 30)
            elif unit == 'years':
                try:
                    target_date = now.replace(year=now.year - value)
                except ValueError:
                    target_date = now.replace(year=now.year - value, day=28)
            
            return target_date.strftime('%Y-%m-%d')
    
    # 4. ISO 8601 및 유사 형식 처리
    try:
        # T와 Z가 포함된 ISO 형식
        iso_cleaned = original_date_str.replace(' ', 'T')
        dt_obj = date_parser.isoparse(iso_cleaned)
        return dt_obj.strftime('%Y-%m-%d')
    except (ValueError, TypeError):
        pass
    
    # 5. 다양한 날짜 형식 시도 (더 많은 형식 추가)
    formats = [
        # 기본 형식들
        '%Y-%m-%d %H:%M:%S', '%Y/%m/%d %H:%M:%S', '%Y.%m.%d %H:%M:%S',
        '%Y-%m-%d', '%Y/%m/%d', '%d-%m-%Y', '%d/%m/%Y', '%m/%d/%Y',
        '%Y.%m.%d', '%d.%m.%Y', '%m.%d.%Y',
        
        # 영어 월 이름
        '%b %d, %Y', '%B %d, %Y', '%d %b %Y', '%d %B %Y',
        '%b %d %Y', '%B %d %Y', '%Y %b %d', '%Y %B %d',
        
        # 한국어 형식
        '%Y년 %m월 %d일', '%Y. %m. %d.', '%Y. %m. %d', '%y.%m.%d', '%Y년%m월%d일',
        
        # 특수 형식들
        '%Y%m%d', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%SZ',
        '%Y. %m. %d. %H:%M', '%Y/%m/%d %H:%M', '%d/%m/%Y %H:%M',
        
        # 추가 영어 형식
        '%a, %d %b %Y', '%A, %B %d, %Y', '%d-%b-%Y',
        
        # 숫자만으로 구성된 형식
        '%Y%m%d%H%M%S', '%Y%m%d%H%M',
    ]
    
    for fmt in formats:
        try:
            date_obj = datetime.strptime(original_date_str, fmt)
            return date_obj.strftime('%Y-%m-%d')
        except ValueError:
            continue
    
    # 6. dateutil.parser로 최종 시도 (더 관대한 설정)
    try:
        parsed_date = date_parser.parse(original_date_str, fuzzy=True, dayfirst=False, yearfirst=True)
        return parsed_date.strftime('%Y-%m-%d')
    except (ValueError, TypeError, OverflowError) as e:
        print(f"날짜 파싱 최종 실패: '{original_date_str}' ({e})")
        return original_date_str

# 향상된 날짜 관련성 확인
def is_relevant_date(date_str: str, target_date: Optional[str] = None, timeframe_hours: int = 48) -> bool:
    if not date_str:
        print("📅 날짜 정보 없음 - 관대하게 포함함")
        return True  # 날짜 정보가 없으면 포함 (더 관대한 정책)

    now_utc = datetime.now(timezone.utc)
    cutoff_utc = now_utc - timedelta(hours=timeframe_hours)
    
    print(f"📅 날짜 확인: '{date_str}', 기준: {timeframe_hours}시간 이내")
    
    try:
        # 다양한 형식의 날짜 처리
        parsed_date_str = parse_date(date_str)
        if not parsed_date_str or parsed_date_str == date_str:
            # 파싱 실패 시 더 관대하게 처리
            print(f"📅 날짜 파싱 실패하지만 포함: {date_str}")
            return True
        
        # YYYY-MM-DD 형식으로 파싱된 경우
        if re.match(r'\d{4}-\d{2}-\d{2}', parsed_date_str):
            date_obj = datetime.strptime(parsed_date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            
            # target_date가 있으면 해당 날짜 이후인지 확인
            if target_date:
                target_date_obj = datetime.strptime(target_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
                if date_obj < target_date_obj:
                    print(f"📅 대상 날짜({target_date}) 이전의 콘텐츠 - 제외")
                    return False
            
            # timeframe_hours 이내인지 확인 (더 관대한 기준)
            # 날짜만 있는 경우 하루 전체를 커버하도록 24시간 여유를 줌
            extended_cutoff = cutoff_utc - timedelta(hours=24)
            is_recent = date_obj >= extended_cutoff
            
            if not is_recent:
                print(f"📅 시간 범위 초과: {date_obj.isoformat()} < {extended_cutoff.isoformat()}")
                # 하지만 일주일 이내라면 포함 (백업 정책)
                week_cutoff = now_utc - timedelta(days=7)
                if date_obj >= week_cutoff:
                    print(f"📅 백업 정책: 일주일 이내이므로 포함")
                    return True
                return False
            
            print(f"📅 날짜 필터 통과: {date_obj.isoformat()}")
            return True
        
        return True  # 기타 경우는 포함
        
    except Exception as e:
        print(f"📅 날짜 처리 중 오류: {str(e)} - 포함함")
        return True

# Playwright를 사용한 동적 크롤링 클래스 (대폭 개선)
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
        self.base_host = None
        # 사이트 감지 결과 캐싱
        self.site_detection_cache = {}
        
        print("🚀 간소화된 사이트별 특화 크롤러 초기화")
    
    def _load_json_configurations(self):
        """JSON 설정 파일들을 로드하는 헬퍼 메서드"""
        print("📋 간소화된 버전: JSON 설정 로더 비활성화됨")
        return
    
    def _add_target_site_configs(self):
        """현재 타겟 사이트들에 대한 특화된 설정을 추가"""
        print("📋 간소화된 버전: 사이트별 특화 크롤링 사용")
        return
    
    def _print_loaded_configurations(self):
        """로드된 설정들의 요약을 출력"""
        print("🔧 간소화된 버전: 사이트별 특화 크롤러")
        return
    
    def add_custom_site_config(self, domain: str, selectors: Dict[str, List[str]]):
        """런타임에 커스텀 사이트 설정을 추가하는 메서드"""
        print(f"⚠️ 간소화된 버전: 커스텀 설정 비활성화됨 ({domain})")
        return
    
    def _extract_domain_name(self, url: str) -> str:
        """URL에서 도메인명 추출"""
        try:
            parsed = urllib.parse.urlparse(url)
            domain = parsed.netloc.lower()
            # www. 제거
            if domain.startswith('www.'):
                domain = domain[4:]
            return domain
        except Exception:
            return url
    
    def validate_site_config(self, domain: str) -> bool:
        """사이트 설정의 유효성을 검증하는 메서드"""
        print(f"✅ 간소화된 버전: {domain} 설정 검증 통과")
        return True
    
    async def initialize(self):
        """브라우저 초기화 (더 안정적인 설정)"""
        try:
            self.playwright = await async_playwright().start()
            
            # 더 안정적인 브라우저 설정
            self.browser = await self.playwright.chromium.launch(
                headless=self.headless,
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-security',
                    '--disable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ]
            )
            
            # 컨텍스트 설정 개선
            self.context = await self.browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                java_script_enabled=True,
                accept_downloads=False,
                ignore_https_errors=True,
                bypass_csp=True,  # CSP 우회
                extra_http_headers={
                    'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                }
            )
            
            # 타임아웃 설정
            self.context.set_default_navigation_timeout(90000)  # 90초
            self.context.set_default_timeout(45000)  # 45초
            
            print("브라우저 및 컨텍스트 초기화 완료")
            
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
    
    async def handle_popups_and_overlays(self, page: Page) -> None:
        """향상된 팝업 및 오버레이 처리"""
        try:
            # 일반적인 팝업 선택자들
            popup_selectors = [
                # 쿠키 관련
                "button:has-text('Accept')", "button:has-text('Agree')", 
                "button:has-text('Accept Cookies')", "button:has-text('Allow Cookies')",
                "button:has-text('Accept All')", "button:has-text('Got it')",
                "button:has-text('OK')", "button:has-text('확인')",
                "button[id*='cookie'][id*='accept']", "button[class*='cookie'][class*='accept']",
                
                # GDPR 관련
                "button:has-text('I Understand')", "button:has-text('Understood')",
                "button:has-text('Continue')", "button:has-text('Proceed')",
                
                # 뉴스레터/구독 관련
                "button:has-text('Maybe Later')", "button:has-text('No Thanks')",
                "button:has-text('Skip')", "button:has-text('Close')",
                "[aria-label*='close']", "[aria-label*='dismiss']",
                
                # 일반적인 닫기 버튼
                ".close", ".dismiss", ".popup-close", ".modal-close",
                "[data-dismiss]", "[data-close]",
                
                # 특정 사이트 패턴
                "div[role='dialog'] button", "div[aria-modal='true'] button"
            ]
            
            # ESC 키 시도
            await page.keyboard.press('Escape')
            await page.wait_for_timeout(1000)
            
            # 각 선택자 시도
            for selector in popup_selectors:
                try:
                    elements = page.locator(selector)
                    count = await elements.count()
                    
                    for i in range(min(count, 3)):  # 최대 3개까지만 시도
                        element = elements.nth(i)
                        if await element.is_visible() and await element.is_enabled():
                            await element.click(timeout=3000)
                            print(f"팝업 버튼 클릭: {selector}")
                            await page.wait_for_timeout(1000)
                            break
                except Exception:
                    continue
            
            # 오버레이 제거 (JavaScript)
            await page.evaluate(r'''() => {
                // 고정 위치 오버레이 제거
                const overlays = document.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"]');
                overlays.forEach(el => {
                    const zIndex = window.getComputedStyle(el).zIndex;
                    if (parseInt(zIndex) > 1000) {
                        el.style.display = 'none';
                    }
                });
                
                // 일반적인 오버레이 클래스 제거
                const overlayClasses = ['.overlay', '.modal-backdrop', '.popup-overlay', '.cookie-banner'];
                overlayClasses.forEach(className => {
                    const elements = document.querySelectorAll(className);
                    elements.forEach(el => el.style.display = 'none');
                });
            }''')
            
        except Exception as e:
            print(f"팝업 처리 중 오류: {e}")
    
    async def analyze_page_structure(self, page: Page, url: str) -> Dict[str, Any]:
        """향상된 페이지 구조 분석"""
        try:
            # 사이트 감지 (캐싱 사용)
            if url not in self.site_detection_cache:
                self.site_detection_cache[url] = await SiteDetector.detect_site_type(page)
            
            site_detection = self.site_detection_cache[url]
            
            # 사이트별 설정 가져오기
            self.current_site_config = site_config_manager.get_config(url)
            print(f"사이트 설정 적용: {self.current_site_config.domain} (감지된 유형: {site_detection['platform']}/{site_detection['cms']})")
            
            # 동적으로 감지된 선택자와 기존 설정 결합
            universal_selectors = site_config_manager.get_universal_selectors()
            detected_selectors = site_detection['selectors']
            
            # 선택자 우선순위: 사이트별 > 감지된 것 > 범용
            article_selectors = (
                self.current_site_config.article_selectors +
                detected_selectors['articles'] +
                universal_selectors['article_selectors']
            )
            
            # 중복 제거하면서 순서 유지
            article_selectors = list(dict.fromkeys(article_selectors))
            
            # 페이지에서 링크 추출 (더 스마트한 방식)
            links = await page.evaluate(r'''(selectors, siteType) => {
                console.log('🔍 사용할 선택자들:', selectors);
                console.log('🏛️ 사이트 유형:', siteType);
                
                let allLinks = [];
                const processedHrefs = new Set();
                let totalElements = 0;
                
                // 각 선택자에 대해 링크 수집
                for (const selector of selectors) {
                    try {
                        const elements = document.querySelectorAll(selector);
                        totalElements += elements.length;
                        console.log(`🔍 선택자 "${selector}": ${elements.length}개 요소 발견`);
                        
                        elements.forEach((link, index) => {
                            const href = link.getAttribute('href');
                            if (!href || processedHrefs.has(href)) return;
                            
                            // 링크 품질 검사 (더 관대하게)
                            if (href.startsWith('javascript:') || 
                                href.startsWith('mailto:') || 
                                href.startsWith('tel:') ||
                                href === '#' ||
                                href.length < 3) {
                                return;
                            }
                            
                            processedHrefs.add(href);
                            
                            // 더 정교한 날짜 추출
                            let dateStr = '';
                            
                            // 1. 링크가 속한 컨테이너에서 날짜 찾기
                            const containers = [
                                'article', '.post', '.entry', '.news-item', '.story', '.item',
                                '[role="listitem"]', '[role="article"]', '.content-item', 
                                '.blog-post', '.post-item', '.news-post', 'li', '.card'  // 추가 컨테이너
                            ];
                            
                            let container = null;
                            for (const containerSelector of containers) {
                                container = link.closest(containerSelector);
                                if (container) break;
                            }
                            
                            if (container) {
                                // 날짜 선택자들 (확장됨)
                                const dateSelectors = [
                                    'time', '[datetime]', '.date', '.published', '.timestamp',
                                    '.post-date', '.article-date', '.entry-date', '.published-date',
                                    '.byline time', '.meta time', '[data-date]', '.age', '.subtext',
                                    'span[title*="20"]', 'span[aria-label*="20"]', 'abbr.published',
                                    '.timestamp-text', 'span[class*="date"]'  // 추가 선택자
                                ];
                                
                                for (const dateSelector of dateSelectors) {
                                    const dateEl = container.querySelector(dateSelector);
                                    if (dateEl) {
                                        let text = dateEl.getAttribute('datetime') || 
                                                  dateEl.getAttribute('title') || 
                                                  dateEl.getAttribute('data-date') ||
                                                  dateEl.textContent;
                                        
                                        if (text && text.trim()) {
                                            text = text.trim();
                                            // 날짜 패턴 확인 (더 관대하게)
                                            if (/\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/i.test(text) ||
                                                /\\b(\\d{1,2})\\s*(hour|day|week|month|year)s?\\s*(ago|전)\\b/i.test(text) ||
                                                /\\b(today|yesterday|오늘|어제|방금|now|지금)\\b/i.test(text) ||
                                                /\\d{4}-\\d{2}-\\d{2}/.test(text) ||
                                                /\\d{1,2}\\s*(시간|일|주|개월)\\s*(전|ago)/.test(text)) {
                                                dateStr = text;
                                                break;
                                            }
                                        }
                                    }
                                }
                                
                                // 백업: 텍스트에서 날짜 패턴 찾기 (더 많은 패턴)
                                if (!dateStr) {
                                    const textContent = container.textContent || '';
                                                                    const datePatterns = [
                                    /\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4}\\b/g,
                                    /\\b\\d{1,2}\\s*(hour|day|week|month)s?\\s*ago\\b/g,
                                    /\\b(today|yesterday|방금|지금|오늘|어제)\\b/g,
                                    /\\d{4}-\\d{2}-\\d{2}/g,
                                    /\\d{1,2}\\s*(시간|일|주|개월)\\s*전/g
                                ];
                                    
                                    for (const pattern of datePatterns) {
                                        const match = textContent.match(pattern);
                                        if (match) {
                                            dateStr = match[0];
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // 링크 텍스트 추출 (더 스마트하게)
                            let linkText = (link.innerText || link.textContent || '').trim();
                            if (!linkText) {
                                // 이미지 alt 텍스트나 title 속성도 확인
                                const img = link.querySelector('img');
                                if (img) {
                                    linkText = img.getAttribute('alt') || img.getAttribute('title') || '';
                                }
                                if (!linkText) {
                                    linkText = link.getAttribute('title') || link.getAttribute('aria-label') || '';
                                }
                            }
                            
                            // 링크 정보 생성
                            const linkData = {
                                href: href,
                                text: linkText,
                                classes: link.className || '',
                                id: link.id || '',
                                date: dateStr,
                                selector_used: selector,
                                container_tag: container ? container.tagName.toLowerCase() : 'none'
                            };
                            
                            // 텍스트 길이 필터링 (더 관대하게)
                            if (linkData.text.length >= 2 && linkData.text.length <= 300) {  // 5자에서 2자로, 200자에서 300자로
                                allLinks.push(linkData);
                            }
                        });
                    } catch (e) {
                        console.warn('⚠️ 선택자 처리 오류:', selector, e);
                    }
                }
                
                console.log(`📊 통계: 총 ${totalElements}개 요소 검사, ${allLinks.length}개 유효 링크 추출`);
                
                // 백업: 기본 링크 추출 (아무것도 찾지 못한 경우)
                if (allLinks.length === 0) {
                    console.log('🔄 백업 링크 추출 시도...');
                    const fallbackSelectors = ['a[href]', 'a'];
                    
                    for (const selector of fallbackSelectors) {
                        const links = document.querySelectorAll(selector);
                        console.log(`🔄 백업 선택자 "${selector}": ${links.length}개 링크`);
                        
                        Array.from(links).slice(0, 50).forEach(link => {  // 최대 50개만
                            const href = link.getAttribute('href');
                            const text = (link.textContent || '').trim();
                            
                            if (href && href.length > 3 && text.length > 2 && 
                                !href.startsWith('javascript:') && 
                                !href.startsWith('mailto:') && 
                                !processedHrefs.has(href)) {
                                
                                processedHrefs.add(href);
                                allLinks.push({
                                    href: href,
                                    text: text,
                                    classes: link.className || '',
                                    id: link.id || '',
                                    date: '',
                                    selector_used: 'fallback:' + selector,
                                    container_tag: 'fallback'
                                });
                            }
                        });
                        
                        if (allLinks.length > 0) break;
                    }
                }
                
                // 품질 점수 계산 및 정렬
                allLinks.forEach(link => {
                    let score = 0;
                    
                    // 날짜가 있으면 가점
                    if (link.date) score += 5;
                    
                    // 제목 품질 점수
                    const titleWords = link.text.split(/\\s+/).length;
                    if (titleWords >= 2 && titleWords <= 20) score += 3;  // 3에서 2로 완화
                    
                    // URL 품질 점수
                    if (link.href.includes('/article/') || 
                        link.href.includes('/post/') || 
                        link.href.includes('/story/') ||
                        link.href.includes('/blog/') ||
                        link.href.includes('/news/') ||
                        link.href.includes('/discover/') ||
                        link.href.includes('/item?id=')) {
                        score += 2;
                    }
                    
                    // 컨테이너 품질 점수
                    if (link.container_tag === 'article' || 
                        link.container_tag === 'li' ||
                        link.container_tag === 'div') {
                        score += 1;
                    }
                    
                    link.quality_score = score;
                });
                
                // 품질 점수와 날짜 기준 정렬
                return allLinks
                    .sort((a, b) => {
                        // 먼저 품질 점수로 정렬
                        if (b.quality_score !== a.quality_score) {
                            return b.quality_score - a.quality_score;
                        }
                        // 같은 품질이면 날짜로 정렬
                        if (a.date && b.date) {
                            try {
                                return new Date(b.date) - new Date(a.date);
                            } catch (e) {
                                return 0;
                            }
                        }
                        return a.date ? -1 : (b.date ? 1 : 0);
                    });
            }''', article_selectors, site_detection['platform'])
            
            print(f"🔍 분석 완료: {len(links)}개 링크 추출 (사이트 유형: {site_detection['platform']})")
            
            # 링크가 없으면 더 상세한 진단 정보 출력
            if len(links) == 0:
                print("⚠️ 경고: 링크 추출 실패!")
                print("🔍 페이지 진단 정보:")
                
                # 페이지 기본 정보 확인
                page_info = await page.evaluate(r'''() => {
                    return {
                        title: document.title,
                        url: window.location.href,
                        totalLinks: document.querySelectorAll('a').length,
                        articles: document.querySelectorAll('article').length,
                        h1Count: document.querySelectorAll('h1').length,
                        h2Count: document.querySelectorAll('h2').length,
                        h3Count: document.querySelectorAll('h3').length,
                        hasMain: document.querySelectorAll('main').length > 0,
                        bodyClass: document.body ? document.body.className : 'none'
                    };
                }''')
                
                print(f"   📄 페이지 제목: {page_info['title']}")
                print(f"   🔗 총 링크 수: {page_info['totalLinks']}")
                print(f"   📰 Article 태그: {page_info['articles']}개")
                print(f"   📝 제목 태그: H1({page_info['h1Count']}), H2({page_info['h2Count']}), H3({page_info['h3Count']})")
                print(f"   🏗️ Main 태그: {'있음' if page_info['hasMain'] else '없음'}")
                print(f"   🎨 Body 클래스: {page_info['bodyClass'][:100]}...")
            
            else:
                # 성공 시 링크 품질 분포 출력
                quality_distribution = {}
                for link in links[:10]:  # 상위 10개만 확인
                    score = link.get('quality_score', 0)
                    quality_distribution[score] = quality_distribution.get(score, 0) + 1
                
                print(f"🎯 상위 링크 품질 분포: {quality_distribution}")

            # URL 정규화를 위해 현재 페이지의 호스트 저장
            parsed_url = urllib.parse.urlparse(url)
            self.base_host = f"{parsed_url.scheme}://{parsed_url.netloc}"

            # 콘텐츠 선택자 결합
            content_selectors = (
                self.current_site_config.content_selectors +
                detected_selectors['content'] +
                universal_selectors['content_selectors']
            )
            content_selector_str = ', '.join(list(dict.fromkeys(content_selectors)))

            return {
                'url': url,
                'links': links,
                'structure': {
                    'contentSelector': content_selector_str, 
                    'hasContent': True,
                    'siteType': site_detection
                }
            }
            
        except Exception as e:
            print(f"페이지 구조 분석 오류: {str(e)}")
            return {
                'url': url, 
                'links': [], 
                'structure': {
                    'contentSelector': None, 
                    'hasContent': False,
                    'siteType': {'platform': 'unknown', 'cms': 'unknown'}
                }
            }
    
    async def filter_relevant_links(self, links: List[Dict[str, Any]], content_focus: Optional[str] = None) -> List[Dict[str, Any]]:
        """향상된 링크 필터링 (품질 기반, 더 관대한 정책)"""
        if not links:
            return []

        print(f"🔗 필터링 전 링크 수: {len(links)}")

        # 현재 사이트 설정 사용
        site_config = self.current_site_config or site_config_manager.get_config(self.base_host or "")

        filtered_links = []
        included_by_pattern = 0
        excluded_by_pattern = 0

        for i, link_data in enumerate(links):
            href = link_data.get('href', '')
            if not href:
                continue
            
            # URL 절대 경로로 변환
            try:
                if self.base_host and not href.startswith(('http://', 'https://')):
                    normalized_href = urllib.parse.urljoin(self.base_host, href)
                    href = normalized_href
                    link_data['href'] = href
            except Exception as e:
                print(f"❌ URL 정규화 중 오류: {e}")
                continue
            
            link_text = link_data.get('text', '')
            
            # 사이트별 포함 패턴 확인 (우선순위)
            included = False
            for pattern in site_config.included_url_patterns:
                if pattern in href.lower():
                    filtered_links.append(link_data)
                    included = True
                    included_by_pattern += 1
                    print(f"✅ 포함 패턴 매칭 [{i+1}]: {pattern} in {href[:60]}...")
                    break
            
            if included:
                continue
                
            # 제외 패턴 확인 (기본 제외 목록을 더 제한적으로)
            excluded = False
            basic_excluded_patterns = [
                '/login', '/register', '/signup', '/subscribe', '/account',
                '/profile', '/settings', '/privacy', '/terms', '/contact',
                '/about', '/search', '/feed/', '/rss/', '/xml', '/sitemap',
                '/wp-admin', '/admin', '/ads/', '/advertisement'
            ]
            
            # 사이트별 제외 패턴 + 기본 제외 패턴
            all_excluded_patterns = site_config.excluded_url_patterns + basic_excluded_patterns
            
            for pattern in all_excluded_patterns:
                if pattern in href.lower():
                    excluded = True
                    excluded_by_pattern += 1
                    print(f"❌ 제외 패턴 매칭 [{i+1}]: {pattern} in {href[:60]}...")
                    break
            
            # 추가 휴리스틱 필터링 (더 관대하게)
            if not excluded:
                # 너무 짧은 링크 텍스트 확인 (더 관대하게)
                if len(link_text.strip()) < 3:
                    print(f"⚠️ 링크 텍스트 너무 짧음 [{i+1}]: '{link_text}' - 제외")
                    continue
                
                # 명백히 콘텐츠가 아닌 링크들 (더 제한적으로)
                non_content_keywords = ['javascript:', 'mailto:', 'tel:', '#top', '#bottom', 'void(0)']
                if any(keyword in href.lower() for keyword in non_content_keywords):
                    print(f"⚠️ 비콘텐츠 링크 [{i+1}]: {href[:60]}... - 제외")
                    continue
                
                filtered_links.append(link_data)
                print(f"✅ 일반 필터 통과 [{i+1}]: {link_text[:40]}...")

        print(f"🔗 기본 필터링 후 링크 수: {len(filtered_links)} (포함패턴: {included_by_pattern}, 제외패턴: {excluded_by_pattern})")
        
        # 콘텐츠 관련성 필터링 (더 관대하게)
        if content_focus and len(filtered_links) > 10:  # 링크가 많을 때만 적용
            print(f"🎯 콘텐츠 관련성 필터링 적용: '{content_focus}'")
            relevant_keywords = content_focus.lower().split()
            scored_links = []
            
            for link in filtered_links:
                score = link.get('quality_score', 0)
                text = link.get('text', '').lower()
                href = link.get('href', '').lower()
                
                # 키워드 매칭 점수 추가
                for keyword in relevant_keywords:
                    if keyword in text:
                        score += 5  # 제목에 키워드
                    if keyword in href:
                        score += 2  # URL에 키워드
                
                # 기술/뉴스 관련 키워드 추가 점수
                tech_keywords = ['ai', 'artificial intelligence', 'tech', 'technology', 
                               'innovation', 'startup', 'digital', 'software', 'hardware', 
                               'machine learning', 'deep learning', 'neural', 'llm', 'gpt']
                for keyword in tech_keywords:
                    if keyword in text or keyword in href:
                        score += 1
                
                scored_links.append((link, score))
            
            # 점수 기준 정렬
            scored_links.sort(key=lambda x: x[1], reverse=True)
            final_links = [link for link, _ in scored_links[:25]]  # 상위 25개로 확대
            
        else:
            # 품질 점수 기준으로 정렬
            filtered_links.sort(key=lambda x: x.get('quality_score', 0), reverse=True)
            final_links = filtered_links[:20]  # 상위 20개로 확대
        
        print(f"🎯 최종 선택된 링크 수: {len(final_links)}")
        
        # 선택된 링크들의 간단한 정보 출력
        for i, link in enumerate(final_links[:5], 1):  # 처음 5개만 표시
            print(f"   {i}. [{link.get('quality_score', 0)}점] {link.get('text', 'No title')[:50]}...")
        
        if len(final_links) > 5:
            print(f"   ... 및 추가 {len(final_links) - 5}개 링크")
        
        return final_links
    
    async def extract_content(self, page: Page, structure: Dict[str, Any]) -> Dict[str, Any]:
        """향상된 콘텐츠 추출"""
        try:
            content_selector = structure.get('contentSelector')
            page_url = page.url
            site_type = structure.get('siteType', {})

            # 더 스마트한 콘텐츠 추출
            content_data = await page.evaluate(f'''(selector, siteType) => {{
                let mainElement = null;
                
                // 1. 사이트별 맞춤 선택자 시도
                if (siteType.cms === 'wordpress') {{
                    const wpSelectors = ['.entry-content', '.post-content', 'article .content'];
                    for (const sel of wpSelectors) {{
                        mainElement = document.querySelector(sel);
                        if (mainElement) break;
                    }}
                }} else if (siteType.cms === 'medium') {{
                    const mediumSelectors = ['article section', '.postArticle-content'];
                    for (const sel of mediumSelectors) {{
                        mainElement = document.querySelector(sel);
                        if (mainElement) break;
                    }}
                }}
                
                // 2. 제공된 선택자 시도
                if (!mainElement && selector) {{
                    const selectors = selector.split(',').map(s => s.trim());
                    for (const sel of selectors) {{
                        try {{
                            mainElement = document.querySelector(sel);
                            if (mainElement) break;
                        }} catch (e) {{}}
                    }}
                }}
                
                // 3. 시맨틱 태그 시도
                if (!mainElement) {{
                    const semanticSelectors = ['article', 'main', '[role="main"]', '[role="article"]'];
                    for (const sel of semanticSelectors) {{
                        mainElement = document.querySelector(sel);
                        if (mainElement) break;
                    }}
                }}
                
                // 4. 텍스트 밀도 기반 자동 감지
                if (!mainElement) {{
                    let bestElement = null;
                    let maxScore = 0;
                    
                    const candidates = document.querySelectorAll('div, section, article');
                    candidates.forEach(el => {{
                        if (el.offsetHeight === 0) return; // 숨겨진 요소 제외
                        
                        const textLength = (el.textContent || '').length;
                        const linkCount = el.querySelectorAll('a').length;
                        const imgCount = el.querySelectorAll('img').length;
                        
                        // 점수 계산 (텍스트 많음, 링크 적음이 좋음)
                        let score = textLength;
                        score -= linkCount * 50; // 링크가 많으면 감점
                        score += imgCount * 20;  // 이미지는 약간 가점
                        
                        // 클래스명으로 가점/감점
                        const className = el.className.toLowerCase();
                        if (className.includes('content') || className.includes('article') || className.includes('post')) {{
                            score += 100;
                        }}
                        if (className.includes('sidebar') || className.includes('nav') || className.includes('footer') || className.includes('header')) {{
                            score -= 200;
                        }}
                        
                        if (score > maxScore && textLength > 200) {{
                            maxScore = score;
                            bestElement = el;
                        }}
                    }});
                    
                    mainElement = bestElement;
                }}
                
                // 5. 최후의 수단
                if (!mainElement) {{
                    mainElement = document.body;
                }}
                
                return {{
                    html: mainElement ? mainElement.innerHTML : '',
                    text: mainElement ? mainElement.textContent : '',
                    selector_used: mainElement ? mainElement.tagName + (mainElement.className ? '.' + mainElement.className.split(' ')[0] : '') : 'body'
                }};
            }}''', content_selector, site_type)
            
            if not content_data['html']:
                return {'text': '', 'html': '', 'images': [], 'videos': [], 'date': ''}
            
            # BeautifulSoup으로 HTML 파싱 및 정리
            soup = BeautifulSoup(content_data['html'], 'html.parser')
            
            # 불필요한 요소 제거 (확장된 목록)
            selectors_to_remove = [
                'script', 'style', 'nav', 'footer', 'header', 'aside',
                '.sidebar', '.nav', '.footer', '.menu', '.navigation',
                '.comments', '.comment-section', '.reply-form', '.comment-form',
                '.related-posts', '.related-articles', '.related-content',
                '.advertisement', '.ads', '.ad-container', '.ad-banner',
                '.social-media', '.share-buttons', '.social-share',
                '.author-bio', '.author-box', '.author-info',
                '.tags', '.categories', '.meta', '.breadcrumb',
                '.popup', '.modal', '.overlay', '.newsletter',
                'form', 'input', 'textarea', 'button', 'select',
                '[aria-hidden="true"]', '.hidden', '[style*="display:none"]',
                '.cookie-banner', '.gdpr', '.newsletter-signup'
            ]
            
            for selector in selectors_to_remove:
                for tag in soup.select(selector):
                    tag.decompose()
            
            # 메타데이터 추출
            metadata = await self.extract_metadata(page)
            
            # 이미지 URL 추출 (개선된 필터링)
            image_urls = self.extract_media_urls(soup, page_url, 'img')
            
            # 비디오 URL 추출
            video_urls = self.extract_media_urls(soup, page_url, 'video')
            
            # 텍스트 정리
            text_content = soup.get_text(separator='\n').strip()
            text_content = re.sub(r'\n{3,}', '\n\n', text_content)
            text_content = re.sub(r'\s{3,}', ' ', text_content)
            
            print(f"콘텐츠 추출 완료: {len(text_content)}자, 이미지 {len(image_urls)}개, 비디오 {len(video_urls)}개")
            
            return {
                'text': text_content,
                'html': str(soup),
                'images': image_urls,
                'videos': video_urls,
                'date': metadata['date'],
                'metadata': metadata,
                'selector_used': content_data['selector_used']
            }
            
        except Exception as e:
            print(f"콘텐츠 추출 오류: {str(e)}")
            return {'text': '', 'html': '', 'images': [], 'videos': [], 'date': ''}
    
    def extract_media_urls(self, soup: BeautifulSoup, page_url: str, media_type: str) -> List[str]:
        """미디어 URL 추출 (이미지/비디오)"""
        media_urls = []
        
        try:
            if media_type == 'img':
                # 이미지 추출
                for img in soup.select('img[src]'):
                    src = img.get('src')
                    if not src:
                        continue
                    
                    # URL 정규화
                    src = urllib.parse.urljoin(page_url, src)
                    
                    # 크기 및 품질 필터링
                    width = img.get('width')
                    height = img.get('height')
                    alt = img.get('alt', '').lower()
                    class_name = ' '.join(img.get('class', [])).lower()
                    
                    # 작은 이미지 제외
                    try:
                        if width and int(width) < 150: continue
                        if height and int(height) < 150: continue
                    except (ValueError, TypeError):
                        pass
                    
                    # 아이콘, 로고, 프로필 이미지 제외
                    exclude_keywords = ['icon', 'logo', 'avatar', 'profile', 'badge', 'button', 'emoji']
                    if any(keyword in alt or keyword in class_name for keyword in exclude_keywords):
                        continue
                    
                    # 데이터 URL 제외
                    if src.startswith('data:'):
                        continue
                    
                    media_urls.append(src)
                    
            elif media_type == 'video':
                # 비디오 추출
                # iframe 비디오 (YouTube, Vimeo 등)
                for iframe in soup.select('iframe[src]'):
                    src = iframe.get('src')
                    if not src:
                        continue
                    
                    src = urllib.parse.urljoin(page_url, src)
                    
                    # 비디오 서비스 감지
                    video_domains = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 
                                   'player.twitch.tv', 'ted.com', 'wistia.com', 'brightcove.com']
                    
                    if any(domain in src.lower() for domain in video_domains):
                        media_urls.append(src)
                
                # video 태그
                for video in soup.select('video'):
                    src = video.get('src')
                    if src:
                        media_urls.append(urllib.parse.urljoin(page_url, src))
                    
                    # source 태그
                    for source in video.select('source[src]'):
                        src = source.get('src')
                        if src:
                            media_urls.append(urllib.parse.urljoin(page_url, src))
        
        except Exception as e:
            print(f"미디어 URL 추출 오류: {e}")
        
        # 중복 제거 및 유효한 URL만 반환
        return list(set([url for url in media_urls if url and url.startswith('http')]))
    
    async def extract_metadata(self, page: Page) -> Dict[str, Any]:
        """메타데이터 추출"""
        try:
            metadata = await page.evaluate(r'''() => {
                const meta = {};
                
                // 날짜 정보 추출
                let dateStr = '';
                const dateSelectors = [
                    'meta[property="article:published_time"]',
                    'meta[name="date"]',
                    'meta[name="publish-date"]',
                    'meta[name="publication-date"]',
                    'time[datetime]',
                    'time',
                    '.date', '.published', '.timestamp',
                    '.post-date', '.article-date', '.entry-date'
                ];
                
                for (const selector of dateSelectors) {
                    const el = document.querySelector(selector);
                    if (el) {
                        const content = el.getAttribute('content') || 
                                       el.getAttribute('datetime') || 
                                       el.textContent;
                        if (content && content.trim()) {
                            dateStr = content.trim();
                            break;
                        }
                    }
                }
                
                meta.date = dateStr;
                
                // 기타 메타데이터
                const ogTitle = document.querySelector('meta[property="og:title"]');
                meta.og_title = ogTitle ? ogTitle.content : '';
                
                const ogDescription = document.querySelector('meta[property="og:description"]');
                meta.og_description = ogDescription ? ogDescription.content : '';
                
                const author = document.querySelector('meta[name="author"]') || 
                              document.querySelector('meta[property="article:author"]');
                meta.author = author ? author.content : '';
                
                const keywords = document.querySelector('meta[name="keywords"]');
                meta.keywords = keywords ? keywords.content : '';
                
                return meta;
            }''')
            
            return metadata
            
        except Exception as e:
            print(f"메타데이터 추출 오류: {e}")
            return {'date': ''}
    
    async def extract_headline(self, page: Page) -> str:
        """향상된 제목 추출"""
        try:
            headline = await page.evaluate(r'''() => {
                // 우선순위: og:title > h1 > title
                const ogTitle = document.querySelector('meta[property="og:title"]');
                if (ogTitle && ogTitle.content && ogTitle.content.trim().length > 5) {
                    return ogTitle.content.trim();
                }
                
                const twitterTitle = document.querySelector('meta[name="twitter:title"]');
                if (twitterTitle && twitterTitle.content && twitterTitle.content.trim().length > 5) {
                    return twitterTitle.content.trim();
                }

                // 메인 콘텐츠 영역에서 h1 찾기
                const contentAreas = ['article', 'main', '.content', '.post', '.entry'];
                for (const area of contentAreas) {
                    const container = document.querySelector(area);
                    if (container) {
                        const h1 = container.querySelector('h1');
                        if (h1 && h1.textContent && h1.textContent.trim().length > 5) {
                            return h1.textContent.trim();
                        }
                    }
                }
                
                // 일반 h1
                const h1 = document.querySelector('h1');
                if (h1 && h1.textContent) {
                    const h1Text = h1.textContent.trim();
                    if (h1Text.length > 5 && h1Text.length < 200) {
                        return h1Text;
                    }
                }
                
                // title 태그에서 사이트명 제거
                const titleTag = document.querySelector('title');
                if (titleTag && titleTag.textContent) {
                    let titleText = titleTag.textContent.trim();
                    
                    // 일반적인 구분자로 분리
                    const separators = ['|', '-', '–', '—', ':', '»', '«'];
                    for (const sep of separators) {
                        if (titleText.includes(sep)) {
                            const parts = titleText.split(sep).map(p => p.trim());
                            // 가장 긴 부분을 제목으로 선택
                            parts.sort((a, b) => b.length - a.length);
                            if (parts[0] && parts[0].length > 5) {
                                titleText = parts[0];
                                break;
                            }
                        }
                    }
                    
                    if (titleText.length > 5 && titleText.length < 200) {
                        return titleText;
                    }
                }
                
                return '';
            }''')
            
            return headline
            
        except Exception as e:
            print(f"제목 추출 오류: {str(e)}")
            return ""
    
    async def crawl_url(self, url: str, content_focus: Optional[str] = None, max_links: int = 1, timeframe_hours_for_filter: int = 48) -> CrawlResult:
        """메인 크롤링 메서드 (개선됨)"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print(f"\n{'='*60}")
            print(f"크롤링 시작: {url}")
            print(f"설정 - 최대 링크: {max_links}, 시간 범위: {timeframe_hours_for_filter}시간")
            print(f"{'='*60}")
            
            # 페이지 로드 (더 관대한 오류 처리)
            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=90000)
                print("✅ 페이지 로드 성공")
            except Exception as nav_error:
                print(f"⚠️ 초기 로드 실패, 재시도: {nav_error}")
                try:
                    await page.goto(url, wait_until='load', timeout=60000)
                    print("✅ 재시도 로드 성공")
                except Exception as final_error:
                    print(f"❌ 페이지 로드 최종 실패: {final_error}")
                    result.error = f"Navigation error: {final_error}"
                    return result
            
            # 초기 렌더링 대기
            await page.wait_for_timeout(3000)
            
            # 팝업 및 오버레이 처리
            await self.handle_popups_and_overlays(page)
            
            # 추가 대기 (동적 콘텐츠 로딩)
            await page.wait_for_timeout(2000)
            
            # URL 정규화
            parsed_url = urllib.parse.urlparse(url)
            self.base_host = f"{parsed_url.scheme}://{parsed_url.netloc}"
            print(f"Base host 설정: {self.base_host}")

            # 페이지 구조 분석
            print("🔍 페이지 구조 분석 중...")
            structure = await self.analyze_page_structure(page, url)
            
            if not structure['links']:
                print("⚠️ 경고: 페이지에서 링크를 찾지 못했습니다.")
                result.error = "No links found on the page"
                return result

            # 사이트 정보 저장
            result.site_info = structure['structure'].get('siteType', {})

            # 링크 필터링
            print("🔗 링크 필터링 중...")
            links = await self.filter_relevant_links(structure['links'], content_focus)
            
            if not links:
                print("⚠️ 경고: 관련 링크를 찾지 못했습니다.")
                result.error = "No relevant links found after filtering"
                return result

            # 처리할 링크 선택
            actual_max_links = min(len(links), max_links)
            links_to_crawl = links[:actual_max_links]
            
            print(f"\n📄 처리할 링크 {len(links_to_crawl)}개:")
            for i, link in enumerate(links_to_crawl, 1):
                print(f"  {i}. [{link.get('quality_score', 0)}점] {link.get('text', 'No title')[:60]}...")
                print(f"     📍 {link.get('href', 'No URL')}")

            # 각 링크 처리
            for i, link_info in enumerate(links_to_crawl, 1):
                link_url = link_info.get('href')
                if not link_url:
                    print(f"⚠️ 링크 {i}: URL 없음, 건너뜀")
                    continue

                print(f"\n🔄 [{i}/{len(links_to_crawl)}] 링크 처리 중...")
                print(f"📍 URL: {link_url}")
                
                link_page = None
                try:
                    link_page = await self.context.new_page()
                    
                    # 상대 경로를 절대 경로로 변환
                    if not link_url.startswith(('http://', 'https://')):
                        link_url = urllib.parse.urljoin(self.base_host, link_url)
                        print(f"🔗 URL 정규화: {link_url}")
                    
                    # 링크 페이지 로드
                    try:
                        await link_page.goto(link_url, wait_until='domcontentloaded', timeout=60000)
                        await link_page.wait_for_timeout(2000)
                    except Exception as e:
                        print(f"❌ 링크 페이지 로드 실패: {e}")
                        continue

                    # 팝업 처리
                    await self.handle_popups_and_overlays(link_page)
                    
                    # 콘텐츠 분석 및 추출
                    print("📄 콘텐츠 분석 중...")
                    link_structure = await self.analyze_page_structure(link_page, link_url)
                    content = await self.extract_content(link_page, link_structure['structure'])
                    headline = await self.extract_headline(link_page)
                    
                    # 날짜 정보 확인
                    date_str = link_info.get('date', '') or content.get('date', '')
                    
                    # 날짜 관련성 확인
                    if date_str:
                        date_is_relevant = is_relevant_date(date_str, self.target_date, timeframe_hours_for_filter)
                        if not date_is_relevant:
                            print(f"⏰ 날짜 필터링: '{headline[:50]}...' ({date_str}) - {timeframe_hours_for_filter}시간 초과")
                            continue
                    
                    # 콘텐츠 품질 확인 (더 관대한 기준)
                    content_length = len(content.get('text', ''))
                    has_headline = bool(headline and headline.strip())
                    
                    if not has_headline and content_length < 100:  # 기준을 200자에서 100자로 낮춤
                        print(f"⚠️ 콘텐츠 품질 부족: 제목 없음, 본문 {content_length}자")
                        print(f"   링크: {link_url}")
                        continue
                    
                    # 제목이 있거나 본문이 충분하면 포함
                    if not has_headline:
                        print(f"⚠️ 제목 없지만 본문 충분({content_length}자) - 포함")
                    
                    if content_length < 100:
                        print(f"⚠️ 본문 짧지만({content_length}자) 제목 있음 - 포함")

                    # Story 객체 생성
                    story = Story()
                    story.headline = headline or link_info.get('text', '제목 없음')
                    story.link = link_url
                    story.date_posted = parse_date(date_str) if date_str else ''
                    story.fullContent = content.get('text', '')
                    story.imageUrls = content.get('images', [])
                    story.videoUrls = content.get('videos', [])
                    story.source = self._extract_domain_name(url)  # 소스 사이트 정보 추가
                    
                    # 추가 메타데이터
                    metadata = content.get('metadata', {})
                    if metadata.get('keywords'):
                        story.tags = [tag.strip() for tag in metadata['keywords'].split(',') if tag.strip()]
                    
                    result.stories.append(story)
                    print(f"✅ 콘텐츠 추출 성공: '{story.headline[:50]}...' (출처: {story.source})")
                    
                except Exception as e:
                    print(f"❌ 링크 처리 오류: {str(e)}")
                finally:
                    if link_page and not link_page.is_closed():
                        await link_page.close()
                    
                    # 요청 간 대기 (서버 부하 방지)
                    if i < len(links_to_crawl):
                        await asyncio.sleep(2)
            
            print(f"\n🎉 크롤링 완료: {len(result.stories)}개 기사 수집")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ 크롤링 오류: {str(e)}")
        finally:
            if page and not page.is_closed():
                await page.close()
        
        return result
    
    async def crawl_url_targeted(self, url: str, content_focus: Optional[str] = None, max_links: int = 1, timeframe_hours_for_filter: int = 48) -> CrawlResult:
        """사이트별 특화된 크롤링 메서드"""
        result = CrawlResult(url)
        page = None
        
        try:
            # 사이트별 도메인 확인
            parsed_url = urllib.parse.urlparse(url)
            domain = parsed_url.netloc.lower()
            
            print(f"\n🎯 타겟 크롤링 시작: {domain}")
            print(f"📋 설정 - 최대 링크: {max_links}, 시간 범위: {timeframe_hours_for_filter}시간")
            
            # 사이트별 특화 크롤링 실행
            if 'simonwillison.net' in domain:
                return await self._crawl_simon_willison(url, max_links)
            elif 'news.ycombinator.com' in domain:
                return await self._crawl_hacker_news(url, max_links)
            elif 'deepmind.google' in domain:
                return await self._crawl_deepmind_blog(url, max_links)
            elif 'mindstream.news' in domain:
                return await self._crawl_mindstream_news(url, max_links)
            elif 'aichief.com' in domain:
                return await self._crawl_aichief_news(url, max_links)
            else:
                # 일반 크롤링으로 폴백
                print(f"⚠️ 알려지지 않은 사이트, 일반 크롤링 사용: {domain}")
                return await self.crawl_url(url, content_focus, max_links, timeframe_hours_for_filter)
                
        except Exception as e:
            result.error = str(e)
            print(f"❌ 타겟 크롤링 오류: {str(e)}")
        
        return result
    
    async def _crawl_simon_willison(self, url: str, max_links: int = 1) -> CrawlResult:
        """Simon Willison 블로그 특화 크롤링"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print("📖 Simon Willison 블로그 크롤링 시작")
            
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(2000)
            
            # 최신 블로그 포스트 직접 찾기
            blog_posts = await page.evaluate(r'''() => {
                const posts = [];
                
                // 메인 페이지에서 최신 포스트들 찾기
                const postSelectors = [
                    'article h2 a',
                    'h2 a[href*="/20"]',
                    '.entry-title a',
                    'a[href*="/2024/"], a[href*="/2025/"]'
                ];
                
                for (const selector of postSelectors) {
                    const links = document.querySelectorAll(selector);
                    for (const link of links) {
                        const href = link.href;
                        const title = link.textContent.trim();
                        
                        if (href && title && href.includes('/20') && title.length > 10) {
                            posts.push({
                                url: href,
                                title: title,
                                selector: selector
                            });
                        }
                    }
                }
                
                return posts.slice(0, 5); // 최대 5개
            }''');
            
            print(f"🔍 발견된 포스트: {len(blog_posts)}개")
            
            for i, post in enumerate(blog_posts[:max_links]):
                try:
                    print(f"📄 포스트 {i+1}: {post['title'][:50]}...")
                    
                    # 개별 포스트 페이지 방문
                    post_page = await self.context.new_page()
                    await post_page.goto(post['url'], wait_until='domcontentloaded', timeout=45000)
                    await post_page.wait_for_timeout(1500)
                    
                    # 포스트 내용 추출
                    content_data = await post_page.evaluate(r'''() => {
                        const article = document.querySelector('article') || 
                                       document.querySelector('.entry-content') ||
                                       document.querySelector('#content');
                        
                        if (!article) return { text: '', date: '', title: '' };
                        
                        const title = document.querySelector('h1')?.textContent?.trim() ||
                                     document.title.split('|')[0].trim();
                        
                        const dateEl = document.querySelector('time') ||
                                      document.querySelector('.published') ||
                                      document.querySelector('abbr.published');
                        
                        const date = dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent) : '';
                        
                        return {
                            text: article.textContent.trim(),
                            html: article.innerHTML,
                            title: title,
                            date: date
                        };
                    }''');
                    
                    if content_data['text'] and len(content_data['text']) > 100:
                        story = Story()
                        story.headline = content_data['title'] or post['title']
                        story.link = post['url']
                        story.date_posted = parse_date(content_data['date']) if content_data['date'] else ''
                        story.fullContent = content_data['text']
                        story.imageUrls = []
                        story.videoUrls = []
                        story.source = "simonwillison.net"
                        
                        result.stories.append(story)
                        print(f"✅ 포스트 수집 성공: '{story.headline[:50]}...' (출처: {story.source})")
                    
                    await post_page.close()
                    
                except Exception as e:
                    print(f"❌ 포스트 처리 오류: {e}")
                    if 'post_page' in locals():
                        await post_page.close()
            
            await page.close()
            print(f"🎉 Simon Willison 크롤링 완료: {len(result.stories)}개 포스트")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ Simon Willison 크롤링 오류: {e}")
            if page:
                await page.close()
        
        return result
    
    async def _crawl_hacker_news(self, url: str, max_links: int = 1) -> CrawlResult:
        """Hacker News 특화 크롤링 (시간 정보 추출 개선)"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print("📰 Hacker News 크롤링 시작")
            
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(2000)
            
            # HN 메인 페이지에서 최신 기사들 찾기 (시간 정보 포함)
            stories = await page.evaluate('''() => {
                const stories = [];
                const storyElements = document.querySelectorAll('.athing');
                
                console.log(`🔍 HN: ${storyElements.length}개 스토리 요소 발견`);
                
                for (let i = 0; i < Math.min(10, storyElements.length); i++) {
                    const story = storyElements[i];
                    const titleLink = story.querySelector('.titleline > a');
                    
                    // 다음 sibling에서 메타데이터 추출
                    const metaRow = story.nextElementSibling;
                    let scoreElement = null;
                    let ageElement = null;
                    let ageText = '';
                    
                    if (metaRow) {
                        scoreElement = metaRow.querySelector('.score');
                        // age 정보는 여러 선택자로 시도
                        ageElement = metaRow.querySelector('.age') || 
                                    metaRow.querySelector('span.age') ||
                                    metaRow.querySelector('a[title*="ago"]') ||
                                    metaRow.querySelector('span[title*="ago"]');
                        
                        // age 텍스트 추출
                        if (ageElement) {
                            ageText = ageElement.textContent.trim() || ageElement.getAttribute('title') || '';
                        }
                        
                        // 백업: metaRow 전체 텍스트에서 "ago" 패턴 찾기
                        if (!ageText && metaRow.textContent) {
                            const ageMatch = metaRow.textContent.match(/(\d+\s+(hour|day|minute)s?\s+ago)/i);
                            if (ageMatch) {
                                ageText = ageMatch[0];
                            }
                        }
                    }
                    
                    if (titleLink) {
                        const storyData = {
                            title: titleLink.textContent.trim(),
                            url: titleLink.href,
                            score: scoreElement ? scoreElement.textContent : '0 points',
                            age: ageText,
                            id: story.id
                        };
                        
                        console.log(`HN 스토리 ${i+1}: ${storyData.title.substring(0, 50)}... (${storyData.age || 'No age'})`);
                        stories.push(storyData);
                    }
                }
                
                return stories;
            }''');
            
            print(f"🔍 발견된 HN 스토리: {len(stories)}개")
            
            # 스토리 정보 출력 (시간 포함)
            for i, hn_story in enumerate(stories[:5]):
                age_info = f" ({hn_story['age']})" if hn_story['age'] else " (시간정보없음)"
                print(f"   {i+1}. {hn_story['title'][:50]}...{age_info}")
            
            processed_count = 0
            for i, hn_story in enumerate(stories):
                if processed_count >= max_links:
                    break
                    
                try:
                    print(f"📄 스토리 {processed_count+1}: {hn_story['title'][:50]}...")
                    print(f"⏰ 게시 시간: {hn_story['age'] or 'Unknown'}")
                    
                    # 시간 정보로 최신성 확인 (48시간 이내만)
                    if hn_story['age']:
                        age_text = hn_story['age'].lower()
                        # "X hours ago" 또는 "X days ago" 파싱
                        is_recent = False
                        
                        if 'hour' in age_text or 'minute' in age_text:
                            # 시간/분 단위면 최신으로 간주
                            is_recent = True
                        elif 'day' in age_text:
                            # 일 단위인 경우 숫자 확인
                            import re
                            day_match = re.search(r'(\d+)\s*day', age_text)
                            if day_match and int(day_match.group(1)) <= 2:  # 2일 이내
                                is_recent = True
                        
                        if not is_recent:
                            print(f"⏰ 48시간 초과 스토리 건너뜀: {hn_story['age']}")
                            continue
                    
                    # 외부 링크로 이동하여 내용 추출
                    if hn_story['url'].startswith('http') and 'news.ycombinator.com' not in hn_story['url']:
                        story_page = await self.context.new_page()
                        await story_page.goto(hn_story['url'], wait_until='domcontentloaded', timeout=45000)
                        await story_page.wait_for_timeout(2000)
                        
                        # 외부 사이트 내용 추출
                        content_data = await story_page.evaluate('''() => {
                            const article = document.querySelector('article') ||
                                           document.querySelector('main') ||
                                           document.querySelector('.content') ||
                                           document.querySelector('#content') ||
                                           document.body;
                            
                            const title = document.querySelector('h1')?.textContent?.trim() ||
                                         document.title.split('|')[0].trim();
                            
                            return {
                                text: article ? article.textContent.trim() : '',
                                title: title
                            };
                        }''');
                        
                        if content_data['text'] and len(content_data['text']) > 200:
                            story = Story()
                            story.headline = content_data['title'] or hn_story['title']
                            story.link = hn_story['url']
                            # HN 시간 정보를 날짜로 변환
                            story.date_posted = parse_date(hn_story['age']) if hn_story['age'] else ''
                            story.fullContent = content_data['text'][:2000]  # 길이 제한
                            story.popularity = hn_story['score']
                            story.imageUrls = []
                            story.videoUrls = []
                            story.source = "news.ycombinator.com"
                            
                            result.stories.append(story)
                            processed_count += 1
                            print(f"✅ HN 스토리 수집 성공: '{story.headline[:50]}...' (출처: {story.source})")
                        
                        await story_page.close()
                    else:
                        # HN 내부 링크인 경우 (Ask HN, Show HN 등)
                        print(f"🔗 HN 내부 링크: {hn_story['url']}")
                        
                        story = Story()
                        story.headline = hn_story['title']
                        story.link = hn_story['url']
                        story.date_posted = parse_date(hn_story['age']) if hn_story['age'] else ''
                        story.fullContent = f"Hacker News 토론: {hn_story['title']}"
                        story.popularity = hn_story['score']
                        story.imageUrls = []
                        story.videoUrls = []
                        story.source = "news.ycombinator.com"
                        
                        result.stories.append(story)
                        processed_count += 1
                        print(f"✅ HN 내부 스토리 수집: '{story.headline[:50]}...' (출처: {story.source})")
                    
                except Exception as e:
                    print(f"❌ HN 스토리 처리 오류: {e}")
                    if 'story_page' in locals():
                        await story_page.close()
            
            await page.close()
            print(f"🎉 Hacker News 크롤링 완료: {len(result.stories)}개 스토리")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ Hacker News 크롤링 오류: {e}")
            if page:
                await page.close()
        
        return result
    
    async def _crawl_deepmind_blog(self, url: str, max_links: int = 1) -> CrawlResult:
        """DeepMind 블로그 특화 크롤링 - 첫 페이지 최신 기사 우선"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print("🧠 DeepMind 블로그 크롤링 시작")
            
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(5000)  # 동적 로딩 대기
            
            # 페이지에서 모든 링크를 수집하고 최신순으로 정렬
            blog_posts = await page.evaluate('''() => {
                const posts = [];
                console.log('🔍 DeepMind 페이지 분석 시작...');
                
                // 페이지의 모든 링크 검사
                const allLinks = Array.from(document.querySelectorAll('a'));
                console.log(`총 ${allLinks.length}개 링크 발견`);
                
                // DeepMind 블로그 URL 패턴 필터링
                const blogLinks = allLinks.filter(link => {
                    const href = link.href;
                    const hasText = link.textContent && link.textContent.trim().length > 15;
                    const isBlogPost = href && (
                        href.includes('/discover/blog/') ||
                        href.includes('/research/') ||
                        href.includes('/publications/')
                    );
                    return hasText && isBlogPost;
                });
                
                console.log(`필터링 후 ${blogLinks.length}개 블로그 링크`);
                
                // 각 링크의 메타데이터 수집
                blogLinks.forEach((link, index) => {
                    try {
                        const href = link.href;
                        const title = link.textContent.trim();
                        
                        // 컨테이너에서 날짜 정보 찾기
                        let dateStr = '';
                        let container = link.closest('article, .card, .post, .item, [role="listitem"]');
                        
                        if (container) {
                            // 시간 요소 찾기
                            const timeEl = container.querySelector('time');
                            if (timeEl) {
                                dateStr = timeEl.getAttribute('datetime') || timeEl.textContent;
                            }
                            
                            // 날짜 패턴 텍스트 검색
                            if (!dateStr) {
                                const containerText = container.textContent;
                                const dateMatch = containerText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}/i);
                                if (dateMatch) {
                                    dateStr = dateMatch[0];
                                }
                            }
                        }
                        
                        // DOM 위치 기반 우선순위 (상단에 있을수록 높은 점수)
                        const rect = link.getBoundingClientRect();
                        const topPosition = rect.top + window.scrollY;
                        const priority = Math.max(0, 10000 - topPosition); // 상단에 있을수록 높은 우선순위
                        
                        posts.push({
                            url: href,
                            title: title,
                            date: dateStr,
                            priority: priority,
                            position: index
                        });
                        
                        console.log(`링크 ${index + 1}: ${title.substring(0, 50)}... (위치: ${topPosition}, 우선순위: ${priority})`);
                        
                    } catch (e) {
                        console.warn(`링크 처리 오류:`, e);
                    }
                });
                
                // 우선순위와 위치 기준으로 정렬 (페이지 상단 + 인덱스 순서)
                posts.sort((a, b) => {
                    // 1순위: 날짜가 있는 것
                    if (a.date && !b.date) return -1;
                    if (!a.date && b.date) return 1;
                    
                    // 2순위: 우선순위 (페이지 상단 위치)
                    if (Math.abs(a.priority - b.priority) > 100) {
                        return b.priority - a.priority;
                    }
                    
                    // 3순위: DOM 순서 (먼저 나타나는 것)
                    return a.position - b.position;
                });
                
                console.log('정렬된 상위 5개 포스트:');
                posts.slice(0, 5).forEach((post, i) => {
                    console.log(`${i + 1}. ${post.title.substring(0, 60)}... (날짜: ${post.date || 'N/A'})`);
                });
                
                return posts.slice(0, 10);  // 상위 10개 후보
            }''');
            
            print(f"🔍 발견된 DeepMind 포스트: {len(blog_posts)}개")
            
            # 상위 후보들 출력
            for i, post in enumerate(blog_posts[:5]):
                print(f"   {i+1}. {post['title'][:60]}... ({post.get('date', 'No date')})")
            
            processed_count = 0
            for i, post in enumerate(blog_posts):
                if processed_count >= max_links:
                    break
                    
                try:
                    print(f"📄 포스트 {processed_count+1}: {post['title'][:50]}...")
                    
                    post_page = await self.context.new_page()
                    await post_page.goto(post['url'], wait_until='domcontentloaded', timeout=45000)
                    await post_page.wait_for_timeout(2000)
                    
                    # 포스트 내용 및 날짜 추출
                    content_data = await post_page.evaluate('''() => {
                        const article = document.querySelector('article') ||
                                       document.querySelector('main') ||
                                       document.querySelector('.content') ||
                                       document.querySelector('#content') ||
                                       document.body;
                        
                        const title = document.querySelector('h1')?.textContent?.trim() ||
                                     document.title.split('|')[0].trim();
                        
                        // 더 적극적인 날짜 찾기
                        let date = '';
                        const dateSelectors = [
                            'time[datetime]',
                            'meta[property="article:published_time"]',
                            'meta[name="date"]',
                            '.date',
                            '.published',
                            '.timestamp',
                            '.post-date',
                            '.byline time'
                        ];
                        
                        for (const selector of dateSelectors) {
                            const el = document.querySelector(selector);
                            if (el) {
                                date = el.getAttribute('datetime') || 
                                       el.getAttribute('content') || 
                                       el.textContent;
                                if (date && date.trim()) {
                                    date = date.trim();
                                    break;
                                }
                            }
                        }
                        
                        // 페이지 텍스트에서 날짜 패턴 찾기 (백업)
                        if (!date) {
                            const bodyText = document.body.textContent;
                            const dateMatch = bodyText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}/i);
                            if (dateMatch) {
                                date = dateMatch[0];
                            }
                        }
                        
                        return {
                            text: article ? article.textContent.trim() : '',
                            title: title,
                            date: date
                        };
                    }''');
                    
                    if content_data['text'] and len(content_data['text']) > 200:
                        # 날짜 유효성 확인
                        final_date = content_data['date'] or post.get('date', '')
                        parsed_date = parse_date(final_date) if final_date else ''
                        
                        # 48시간 내 기사인지 확인
                        if parsed_date:
                            is_recent = is_relevant_date(parsed_date, None, 48)
                            if not is_recent:
                                print(f"⏰ 48시간 초과: {post['title'][:50]}... ({parsed_date})")
                                await post_page.close()
                                continue
                        
                        story = Story()
                        story.headline = content_data['title'] or post['title']
                        story.link = post['url']
                        story.date_posted = parsed_date
                        story.fullContent = content_data['text']
                        story.imageUrls = []
                        story.videoUrls = []
                        story.source = "deepmind.google"
                        
                        result.stories.append(story)
                        processed_count += 1
                        print(f"✅ DeepMind 포스트 수집 성공: '{story.headline[:50]}...' (출처: {story.source})")
                    else:
                        print(f"⚠️ 콘텐츠 부족: {len(content_data.get('text', ''))}자")
                    
                    await post_page.close()
                    
                except Exception as e:
                    print(f"❌ DeepMind 포스트 처리 오류: {e}")
                    if 'post_page' in locals():
                        await post_page.close()
            
            await page.close()
            print(f"🎉 DeepMind 크롤링 완료: {len(result.stories)}개 포스트")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ DeepMind 크롤링 오류: {e}")
            if page:
                await page.close()
        
        return result
    
    async def _crawl_mindstream_news(self, url: str, max_links: int = 1) -> CrawlResult:
        """Mindstream News 특화 크롤링 (실제 사이트 구조 기반 최적화)"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print("📺 Mindstream News 크롤링 시작")
            
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(3000)  # 페이지 로딩 대기
            
            # 쿠키 팝업 처리
            await self.handle_popups_and_overlays(page)
            
            # Mindstream Archive 실제 구조 분석 및 최적화된 추출
            articles = await page.evaluate(r'''() => {
                console.log('🔍 Mindstream Archive 구조 분석 시작...');
                
                const articles = [];
                const processedUrls = new Set();
                
                // 전체 페이지에서 날짜 패턴 먼저 찾기
                const pageText = document.body.textContent || '';
                const allDateMatches = [...pageText.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/gi)];
                console.log(`📅 페이지에서 발견된 날짜 패턴: ${allDateMatches.length}개`);
                allDateMatches.forEach(match => console.log(`   날짜: ${match[0]}`));
                
                // Mindstream /p/ 링크들 찾기
                const articleLinks = document.querySelectorAll('a[href*="/p/"]');
                console.log(`🔍 /p/ 패턴 링크 ${articleLinks.length}개 발견`);
                
                articleLinks.forEach((link, index) => {
                    const href = link.href;
                    let title = link.textContent.trim();
                    
                    // 제목이 너무 짧거나 없으면 건너뛰기
                    if (!href || !title || title.length < 10) {
                        console.log(`⚠️ 링크 ${index + 1} 건너뛰기: 제목 부족 ("${title}")`);
                        return;
                    }
                    
                    if (processedUrls.has(href)) {
                        console.log(`⚠️ 링크 ${index + 1} 건너뛰기: 중복 URL`);
                        return;
                    }
                    
                    processedUrls.add(href);
                    
                    // 날짜 추출 전략 개선
                    let dateStr = '';
                    let searchRadius = 5; // 탐색 반경 확대
                    
                    // 전략 1: 링크와 근접한 요소들에서 날짜 찾기
                    let currentElement = link;
                    for (let i = 0; i < searchRadius; i++) {
                        // 부모 요소들 탐색
                        if (currentElement.parentElement) {
                            currentElement = currentElement.parentElement;
                            const elementText = currentElement.textContent || '';
                            const dateMatch = elementText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i);
                            if (dateMatch) {
                                dateStr = dateMatch[0];
                                console.log(`📅 부모 ${i+1}에서 날짜 발견: "${dateStr}" for "${title.substring(0, 30)}..."`);
                                break;
                            }
                        }
                    }
                    
                    // 전략 2: 링크 주변 형제 요소들 탐색
                    if (!dateStr) {
                        const parentElement = link.parentElement;
                        if (parentElement) {
                            const siblings = Array.from(parentElement.children);
                            for (const sibling of siblings) {
                                const siblingText = sibling.textContent || '';
                                const dateMatch = siblingText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i);
                                if (dateMatch) {
                                    dateStr = dateMatch[0];
                                    console.log(`📅 형제 요소에서 날짜 발견: "${dateStr}" for "${title.substring(0, 30)}..."`);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // 전략 3: 페이지 상단부터 순서대로 매칭 (최신 기사일수록 상단에 위치)
                    if (!dateStr && allDateMatches.length > 0) {
                        // 링크의 순서에 따라 날짜 할당 (상단 링크 = 최신 날짜)
                        if (index < allDateMatches.length) {
                            dateStr = allDateMatches[index][0];
                            console.log(`📅 순서 매칭으로 날짜 할당: "${dateStr}" for "${title.substring(0, 30)}..." (위치: ${index + 1})`);
                        } else {
                            // 날짜가 부족한 경우 가장 최신 날짜 사용
                            dateStr = allDateMatches[0][0];
                            console.log(`📅 최신 날짜로 폴백: "${dateStr}" for "${title.substring(0, 30)}..."`);
                        }
                    }
                    
                    // 제목 정리 (불필요한 공백 제거)
                    title = title.replace(/\s+/g, ' ').trim();
                    
                    // DOM 순서 기반 우선순위 (상단 = 최신)
                    const priority = 1000 - index;
                    
                    const article = {
                        url: href,
                        title: title,
                        date: dateStr,
                        priority: priority,
                        index: index,
                        source: 'mindstream'  // 소스 명시
                    };
                    
                    articles.push(article);
                    console.log(`📰 ${index + 1}. "${title.substring(0, 50)}..." → 날짜: ${dateStr || 'N/A'}`);
                });
                
                // 우선순위 정렬 (최신순 유지)
                articles.sort((a, b) => {
                    // 1순위: 날짜가 있는 것 우선
                    if (a.date && !b.date) return -1;
                    if (!a.date && b.date) return 1;
                    
                    // 2순위: 날짜 최신순
                    if (a.date && b.date) {
                        try {
                            const dateA = new Date(a.date);
                            const dateB = new Date(b.date);
                            return dateB - dateA; // 최신순
                        } catch (e) {
                            return b.date.localeCompare(a.date);
                        }
                    }
                    
                    // 3순위: DOM 순서 (상단 우선)
                    return a.index - b.index;
                });
                
                console.log(`📊 Mindstream 총 ${articles.length}개 기사 발견`);
                console.log('🏆 정렬된 상위 기사들:');
                articles.slice(0, 5).forEach((article, i) => {
                    console.log(`   ${i + 1}. ${article.title.substring(0, 50)}... (${article.date || 'No date'})`);
                });
                
                return articles.slice(0, 10);  // 상위 10개
            }''');
            
            print(f"🔍 발견된 Mindstream 기사: {len(articles)}개")
            
            # 상위 후보들 출력
            for i, article in enumerate(articles[:5]):
                print(f"   {i+1}. {article['title'][:60]}... ({article.get('date', 'No date')})")
            
            processed_count = 0
            for i, article in enumerate(articles):
                if processed_count >= max_links:
                    break
                    
                try:
                    print(f"📄 기사 {processed_count+1}: {article['title'][:50]}...")
                    print(f"🔗 URL: {article['url']}")
                    
                    article_page = await self.context.new_page()
                    
                    try:
                        await article_page.goto(article['url'], wait_until='domcontentloaded', timeout=45000)
                        await article_page.wait_for_timeout(3000)
                        
                        # 쿠키 팝업 처리
                        await self.handle_popups_and_overlays(article_page)
                        
                        # Mindstream 특화 콘텐츠 추출
                        content_data = await article_page.evaluate('''() => {
                            console.log('🔍 Mindstream 기사 콘텐츠 추출 시작...');
                            
                            // Mindstream/Beehiiv 플랫폼 특화 콘텐츠 선택자
                            const mindstreamSelectors = [
                                // Beehiiv/Mindstream 기본 콘텐츠 구조
                                'div[data-block-type="paragraph"]',  // Beehiiv 단락
                                'div[data-block-type="unstyled"]',   // Beehiiv 기본 텍스트
                                '.post-content',                     // 일반적인 포스트 콘텐츠
                                'article',                           // 시맨틱 article 태그
                                'main',                              // 메인 콘텐츠
                                '.content',                          // 콘텐츠 클래스
                                '[role="main"]',                     // ARIA 메인 역할
                            ];
                            
                            let contentElement = null;
                            let contentText = '';
                            
                            // 우선순위에 따라 콘텐츠 추출 시도
                            for (const selector of mindstreamSelectors) {
                                const elements = document.querySelectorAll(selector);
                                if (elements.length > 0) {
                                    // 여러 요소가 있는 경우 모든 텍스트 합치기
                                    const combinedText = Array.from(elements)
                                        .map(el => el.textContent.trim())
                                        .filter(text => text.length > 20)  // 짧은 텍스트 제외
                                        .join('\\n\\n');
                                    
                                    if (combinedText.length > contentText.length) {
                                        contentText = combinedText;
                                        contentElement = elements[0];
                                        console.log(`✅ 콘텐츠 선택자 성공: ${selector} (${combinedText.length}자)`);
                                    }
                                }
                            }
                            
                            // 백업: 페이지 전체에서 긴 텍스트 블록 찾기
                            if (!contentText || contentText.length < 200) {
                                console.log('⚠️ 기본 선택자 실패, 백업 방식 시도...');
                                
                                const allDivs = document.querySelectorAll('div, section, article');
                                let bestElement = null;
                                let bestScore = 0;
                                
                                allDivs.forEach(div => {
                                    const text = div.textContent.trim();
                                    const textLength = text.length;
                                    
                                    // 텍스트 길이 기반 점수 계산
                                    if (textLength > 100 && textLength < 10000) {
                                        let score = textLength;
                                        
                                        // 링크 비율로 감점
                                        const linkCount = div.querySelectorAll('a').length;
                                        const linkPenalty = linkCount * 50;
                                        score -= linkPenalty;
                                        
                                        // 좋은 콘텐츠 신호로 가점
                                        const className = div.className.toLowerCase();
                                        if (className.includes('content') || 
                                            className.includes('post') || 
                                            className.includes('article')) {
                                            score += 200;
                                        }
                                        
                                        if (score > bestScore) {
                                            bestScore = score;
                                            bestElement = div;
                                        }
                                    }
                                });
                                
                                if (bestElement) {
                                    contentText = bestElement.textContent.trim();
                                    contentElement = bestElement;
                                    console.log(`✅ 백업 추출 성공: ${contentText.length}자`);
                                }
                            }
                            
                            // 제목 추출 (Mindstream 특화)
                            let title = '';
                            const titleSelectors = [
                                'h1',                               // 메인 제목
                                'meta[property="og:title"]',        // OpenGraph 제목
                                'meta[name="twitter:title"]',       // Twitter 제목
                                'title'                             // 페이지 제목
                            ];
                            
                            for (const selector of titleSelectors) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const candidateTitle = selector.includes('meta') ? 
                                                          el.getAttribute('content') : 
                                                          el.textContent;
                                    if (candidateTitle && candidateTitle.trim().length > 5) {
                                        title = candidateTitle.trim();
                                        // 사이트명 제거 (Mindstream 특화)
                                        title = title.replace(/\\s*[-|–]\\s*Mindstream.*$/i, '');
                                        break;
                                    }
                                }
                            }
                            
                            // 날짜 추출 (Mindstream/Beehiiv 강화)
                            let date = '';
                            
                            // 1단계: 메타데이터에서 날짜 찾기
                            const metaSelectors = [
                                'meta[property="article:published_time"]',  // OpenGraph 발행시간
                                'meta[name="date"]',                        // 날짜 메타
                                'meta[name="publish-date"]',                // 발행 날짜
                                'time[datetime]'                            // HTML5 time 태그
                            ];
                            
                            for (const selector of metaSelectors) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const candidateDate = el.getAttribute('datetime') || 
                                                         el.getAttribute('content');
                                    if (candidateDate && candidateDate.trim()) {
                                        date = candidateDate.trim();
                                        console.log(`📅 메타데이터에서 날짜 발견: ${date}`);
                                        break;
                                    }
                                }
                            }
                            
                            // 2단계: 페이지 본문에서 날짜 패턴 찾기 (Mindstream 특화)
                            if (!date) {
                                const bodyText = document.body.textContent || '';
                                const datePatterns = [
                                    // Mindstream의 "May 23, 2025" 형태
                                    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i,
                                    // ISO 형태
                                    /\d{4}-\d{2}-\d{2}/,
                                    // 다른 형태들
                                    /\d{1,2}\/\d{1,2}\/\d{4}/,
                                    /\d{1,2}\.\d{1,2}\.\d{4}/
                                ];
                                
                                for (const pattern of datePatterns) {
                                    const match = bodyText.match(pattern);
                                    if (match) {
                                        date = match[0];
                                        console.log(`📅 본문에서 날짜 패턴 발견: ${date}`);
                                        break;
                                    }
                                }
                            }
                            
                            // 3단계: DOM 요소에서 날짜 찾기
                            if (!date) {
                                const domSelectors = [
                                    'time',                              // time 태그
                                    '.date, .published, .timestamp',     // 날짜 클래스
                                    '[class*="date"], [id*="date"]',     // 날짜 포함 클래스/ID
                                    'span[title*="2025"], span[title*="2024"]'  // 툴팁에 연도
                                ];
                                
                                for (const selector of domSelectors) {
                                    const elements = document.querySelectorAll(selector);
                                    for (const el of elements) {
                                        const candidateDate = el.getAttribute('title') ||
                                                             el.getAttribute('datetime') ||
                                                             el.textContent;
                                        if (candidateDate && candidateDate.trim()) {
                                            const cleanDate = candidateDate.trim();
                                            // 날짜 패턴 검증
                                            if (/\d{4}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(cleanDate)) {
                                                date = cleanDate;
                                                console.log(`📅 DOM 요소에서 날짜 발견: ${date}`);
                                                break;
                                            }
                                        }
                                    }
                                    if (date) break;
                                }
                            }
                            
                            // 최종 결과
                            const result = {
                                text: contentText,
                                title: title,
                                date: date,
                                contentLength: contentText.length,
                                method: contentElement ? 
                                       `${contentElement.tagName}${contentElement.className ? '.' + contentElement.className.split(' ')[0] : ''}` : 
                                       'text-analysis'
                            };
                            
                            console.log(`📊 Mindstream 추출 결과: ${result.contentLength}자, 제목: "${result.title?.substring(0, 30)}..."`);
                            return result;
                        }''');
                        
                        # 콘텐츠 품질 확인 (Mindstream 최적화)
                        content_length = len(content_data.get('text', ''))
                        has_title = bool(content_data.get('title', '').strip())
                        
                        if content_length > 100 or (has_title and content_length > 50):
                            # 날짜 검증
                            final_date = content_data.get('date') or article.get('date', '')
                            parsed_date = parse_date(final_date) if final_date else ''
                            
                            # 시간 필터링 (Mindstream은 매우 관대하게 - 30일)
                            if parsed_date:
                                is_recent = is_relevant_date(parsed_date, None, 720)  # 30일 (720시간)
                                if not is_recent:
                                    print(f"⏰ 30일 초과: {article['title'][:50]}... ({parsed_date})")
                                    await article_page.close()
                                    continue
                            else:
                                # 날짜가 없어도 Mindstream은 포함 (최신 기사일 가능성)
                                print(f"📅 날짜 정보 없음, 하지만 Mindstream이므로 포함: {article['title'][:50]}...")
                            
                            # Story 객체 생성
                            story = Story()
                            story.headline = content_data.get('title') or article['title']
                            story.link = article['url']
                            story.date_posted = parsed_date
                            story.fullContent = content_data['text']
                            story.imageUrls = []  # Mindstream은 주로 텍스트 기반
                            story.videoUrls = []
                            story.source = "mindstream.news"
                            
                            # Mindstream 특화 메타데이터
                            story.summary = story.fullContent[:200] + "..." if len(story.fullContent) > 200 else story.fullContent
                            story.tags = ['mindstream', 'ai-news', 'tech-news']  # Mindstream 식별 태그
                            
                            # 날짜가 최신인 경우 우선순위 표시
                            if parsed_date:
                                try:
                                    from datetime import datetime
                                    date_obj = datetime.strptime(parsed_date, '%Y-%m-%d') if len(parsed_date) == 10 else datetime.now()
                                    days_old = (datetime.now() - date_obj).days
                                    if days_old <= 3:  # 3일 이내
                                        story.popularity = f"fresh-{days_old}d"  # 신선도 표시
                                except:
                                    pass
                            
                            result.stories.append(story)
                            processed_count += 1
                            
                            print(f"✅ Mindstream 기사 수집 성공: '{story.headline[:50]}...' (출처: {story.source})")
                            
                        else:
                            print(f"⚠️ 콘텐츠 품질 부족:")
                            print(f"   📊 텍스트 길이: {content_length}자")
                            print(f"   📝 제목 존재: {'Yes' if has_title else 'No'}")
                            print(f"   🎯 최소 요구사항: 제목 있으면 50자+, 없으면 100자+")
                        
                    except Exception as page_error:
                        print(f"❌ 페이지 로드 오류: {page_error}")
                    finally:
                        await article_page.close()
                    
                except Exception as e:
                    print(f"❌ Mindstream 기사 처리 오류: {e}")
                    if 'article_page' in locals() and not article_page.is_closed():
                        await article_page.close()
            
            await page.close()
            
            # 결과 요약 출력
            print(f"🎉 Mindstream 크롤링 완료: {len(result.stories)}개 기사")
            if result.stories:
                print("📋 수집된 기사 목록:")
                for i, story in enumerate(result.stories, 1):
                    freshness = f" [{story.popularity}]" if story.popularity else ""
                    print(f"   {i}. {story.headline[:60]}...{freshness}")
                    print(f"      📅 날짜: {story.date_posted or 'Unknown'}")
                    print(f"      📊 내용: {len(story.fullContent)}자")
                    print(f"      🔗 URL: {story.link}")
            else:
                print("⚠️ Mindstream에서 기사를 가져오지 못했습니다.")
                print("🔍 가능한 원인:")
                print("   • 쿠키 팝업이 제대로 처리되지 않음")
                print("   • 페이지 로딩 시간 부족")
                print("   • 날짜 파싱 실패")
                print("   • 콘텐츠 추출 실패")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ Mindstream 크롤링 오류: {e}")
            if page:
                await page.close()
        
        return result
    
    async def _crawl_aichief_news(self, url: str, max_links: int = 1) -> CrawlResult:
        """AIChief Featured 뉴스 특화 크롤링"""
        result = CrawlResult(url)
        page = None
        
        try:
            page = await self.context.new_page()
            print("🤖 AIChief Featured 뉴스 크롤링 시작")
            
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(3000)  # 페이지 로딩 대기
            
            # AIChief Featured 뉴스 찾기 (최신 우선)
            featured_news = await page.evaluate(r'''() => {
                const posts = [];
                console.log('🔍 AIChief Featured 뉴스 검색 시작...');
                
                // Featured 섹션의 뉴스 타겟팅 (더 구체적)
                const featuredSelectors = [
                    // Featured 라벨이 있는 기사들 (최우선)
                    'div:has(span:contains("Featured")) a',
                    '.featured a',
                    '[class*="featured"] a',
                    // 상단 메인 뉴스 영역
                    '.news-grid a',
                    '.post-grid a', 
                    '.article-grid a',
                    // 일반적인 뉴스 기사 링크들
                    'article a',
                    '.news-item a',
                    '.post a',
                    'h2 a',
                    'h3 a'
                ];
                
                const processedHrefs = new Set();
                
                for (const selector of featuredSelectors) {
                    try {
                        const links = document.querySelectorAll(selector);
                        console.log(`AIChief 선택자 "${selector}": ${links.length}개 링크 발견`);
                        
                        for (const link of links) {
                            const href = link.href;
                            const title = (link.textContent || '').trim();
                            
                            // AIChief 뉴스 링크 검증
                            if (href && title && title.length > 15 && 
                                !processedHrefs.has(href) &&
                                !href.includes('#') &&
                                !href.includes('mailto:') &&
                                !href.includes('javascript:') &&
                                !href.includes('aichief.com/submit') &&
                                !href.includes('aichief.com/contact')) {
                                
                                processedHrefs.add(href);
                                
                                // Featured 여부 확인 (더 정교하게)
                                let isFeatured = false;
                                let featuredContainer = link.closest('div, article, section');
                                while (featuredContainer && !isFeatured) {
                                    const containerHtml = featuredContainer.outerHTML.toLowerCase();
                                    const containerText = featuredContainer.textContent.toLowerCase();
                                    
                                    if (containerHtml.includes('featured') || 
                                        containerText.includes('featured') ||
                                        featuredContainer.querySelector('span:contains("Featured")')) {
                                        isFeatured = true;
                                    }
                                    featuredContainer = featuredContainer.parentElement;
                                }
                                
                                // 날짜 추출 (AIChief 특화)
                                let dateStr = '';
                                const container = link.closest('div, article, .news-item, .post');
                                if (container) {
                                    // AIChief 날짜 형식: "May 23, 2025 6:30 AM"
                                    const dateSelectors = ['time', '.date', '.published', '.timestamp', 'span[class*="date"]'];
                                    for (const dateSelector of dateSelectors) {
                                        const dateEl = container.querySelector(dateSelector);
                                        if (dateEl) {
                                            dateStr = dateEl.getAttribute('datetime') || 
                                                     dateEl.textContent || '';
                                            if (dateStr.trim()) break;
                                        }
                                    }
                                    
                                    // 날짜 패턴 매칭 (백업)
                                    if (!dateStr) {
                                        const textContent = container.textContent;
                                        const dateMatch = textContent.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},\\s+\\d{4}/i);
                                        if (dateMatch) {
                                            dateStr = dateMatch[0];
                                        }
                                    }
                                }
                                
                                // 페이지 상단 위치 계산
                                const rect = link.getBoundingClientRect();
                                const topPosition = rect.top + window.scrollY;
                                
                                posts.push({
                                    url: href,
                                    title: title,
                                    selector: selector,
                                    date: dateStr.trim(),
                                    isFeatured: isFeatured,
                                    topPosition: topPosition
                                });
                                
                                console.log(`AIChief 뉴스: ${title.substring(0, 50)}... (Featured: ${isFeatured}, 날짜: ${dateStr})`);
                            }
                        }
                    } catch (e) {
                        console.warn(`AIChief 선택자 오류 ${selector}:`, e);
                    }
                }
                
                // 우선순위 정렬: Featured > 날짜 > 상단 위치
                posts.sort((a, b) => {
                    // 1순위: Featured 여부
                    if (a.isFeatured && !b.isFeatured) return -1;
                    if (!a.isFeatured && b.isFeatured) return 1;
                    
                    // 2순위: 날짜 (최신순)
                    if (a.date && b.date) {
                        try {
                            return new Date(b.date) - new Date(a.date);
                        } catch (e) {
                            // 날짜 파싱 실패 시 문자열 비교
                            return b.date.localeCompare(a.date);
                        }
                    }
                    if (a.date && !b.date) return -1;
                    if (!a.date && b.date) return 1;
                    
                    // 3순위: 페이지 상단 위치
                    return a.topPosition - b.topPosition;
                });
                
                console.log('AIChief 정렬된 상위 뉴스:');
                posts.slice(0, 5).forEach((post, i) => {
                    console.log(`${i + 1}. ${post.title.substring(0, 60)}... (Featured: ${post.isFeatured}, 날짜: ${post.date || 'N/A'})`);
                });
                
                return posts.slice(0, 8);  // 상위 8개 후보
            }''');
            
            print(f"🔍 발견된 AIChief 뉴스: {len(featured_news)}개")
            
            # 상위 후보들 출력
            for i, news in enumerate(featured_news[:5]):
                featured_mark = "⭐" if news['isFeatured'] else "  "
                print(f"   {featured_mark} {i+1}. {news['title'][:60]}... ({news.get('date', 'No date')})")
            
            processed_count = 0
            for i, news in enumerate(featured_news):
                if processed_count >= max_links:
                    break
                    
                try:
                    print(f"📄 AIChief 뉴스 {processed_count+1}: {news['title'][:50]}...")
                    
                    news_page = await self.context.new_page()
                    await news_page.goto(news['url'], wait_until='domcontentloaded', timeout=45000)
                    await news_page.wait_for_timeout(2000)
                    
                    # AIChief 뉴스 내용 추출
                    content_data = await news_page.evaluate(r'''() => {
                        const article = document.querySelector('article') ||
                                       document.querySelector('main') ||
                                       document.querySelector('.content') ||
                                       document.querySelector('.post-content') ||
                                       document.querySelector('#content');
                        
                        if (!article) return { text: '', date: '', title: '' };
                        
                        const title = document.querySelector('h1')?.textContent?.trim() ||
                                     document.querySelector('.title')?.textContent?.trim() ||
                                     document.title.split('|')[0].trim();
                        
                        // AIChief 날짜 추출
                        const dateSelectors = [
                            'time[datetime]',
                            'meta[property="article:published_time"]',
                            '.date',
                            '.published',
                            '.timestamp',
                            'span[class*="date"]'
                        ];
                        
                        let date = '';
                        for (const selector of dateSelectors) {
                            const el = document.querySelector(selector);
                            if (el) {
                                date = el.getAttribute('datetime') || 
                                       el.getAttribute('content') || 
                                       el.textContent;
                                if (date && date.trim()) {
                                    date = date.trim();
                                    break;
                                }
                            }
                        }
                        
                        return {
                            text: article.textContent.trim(),
                            title: title,
                            date: date
                        };
                    }''');
                    
                    if content_data['text'] and len(content_data['text']) > 200:
                        # 날짜 유효성 확인
                        final_date = content_data['date'] or news.get('date', '')
                        parsed_date = parse_date(final_date) if final_date else ''
                        
                        # 48시간 내 기사인지 확인
                        if parsed_date:
                            is_recent = is_relevant_date(parsed_date, None, 48)
                            if not is_recent:
                                print(f"⏰ 48시간 초과: {news['title'][:50]}... ({parsed_date})")
                                await news_page.close()
                                continue
                        
                        story = Story()
                        story.headline = content_data['title'] or news['title']
                        story.link = news['url']
                        story.date_posted = parsed_date
                        story.fullContent = content_data['text']
                        story.imageUrls = []
                        story.videoUrls = []
                        story.source = "aichief.com"
                        
                        result.stories.append(story)
                        processed_count += 1
                        print(f"✅ AIChief 뉴스 수집 성공: '{story.headline[:50]}...' (출처: {story.source})")
                    else:
                        print(f"⚠️ 콘텐츠 부족: {len(content_data.get('text', ''))}자")
                    
                    await news_page.close()
                    
                except Exception as e:
                    print(f"❌ AIChief 뉴스 처리 오류: {e}")
                    if 'news_page' in locals():
                        await news_page.close()
            
            await page.close()
            print(f"🎉 AIChief 크롤링 완료: {len(result.stories)}개 뉴스")
            
        except Exception as e:
            result.error = str(e)
            print(f"❌ AIChief 크롤링 오류: {e}")
            if page:
                await page.close()
        
        return result

async def main():
    """향상된 메인 함수 - 더 나은 에러 처리와 진행 상황 표시"""
    try:
        # 시작 시간 기록
        start_time = time.time()
        
        parser = argparse.ArgumentParser(
            description="향상된 다중 사이트 웹 크롤러",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
사용 예시:
  python dynamic_crawl.py --sources_config '[{"identifier": "https://techcrunch.com/", "maxItems": 3}]'
  python dynamic_crawl.py --sources_config '[{"url": "https://medium.com/", "max_items": 2}, {"url": "https://reddit.com/r/technology", "max_items": 1}]' --content_focus "AI technology"
            """
        )
        
        parser.add_argument(
            "--sources_config",
            type=str,
            required=True,
            help='JSON 설정: [{"identifier": "URL", "maxItems": 수}, ...] 또는 [{"url": "URL", "max_items": 수}, ...]'
        )
        parser.add_argument(
            "--output", 
            type=str, 
            default="crawl_results.json", 
            help="결과 저장 파일 경로 (기본값: crawl_results.json)"
        )
        parser.add_argument(
            "--llm_provider", 
            type=str, 
            default="openai", 
            choices=["openai", "together", "deepseek"], 
            help="LLM 제공자 선택"
        )
        parser.add_argument(
            "--target_date", 
            type=str, 
            default=None, 
            help="대상 날짜 (YYYY-MM-DD 형식). 이 날짜 이후의 콘텐츠만 수집"
        )
        parser.add_argument(
            "--content_focus", 
            type=str, 
            default=None, 
            help="관심 키워드 (예: 'AI technology machine learning')"
        )
        parser.add_argument(
            "--timeframe_hours", 
            type=int, 
            default=48, 
            help="수집 대상 시간 범위 (시간 단위, 기본값: 48시간)"
        )
        parser.add_argument(
            "--headless", 
            action="store_true", 
            default=True,
            help="브라우저 헤드리스 모드 (기본값: True)"
        )
        parser.add_argument(
            "--show-browser", 
            action="store_true", 
            help="브라우저 창 표시 (디버깅용)"
        )

        args = parser.parse_args()
        
        # 소스 설정 파싱
        try:
            sources_config_list = json.loads(args.sources_config)
            if not isinstance(sources_config_list, list):
                sources_config_list = [sources_config_list]
            print(f"✅ 소스 설정 로드 완료: {len(sources_config_list)}개 사이트")
        except json.JSONDecodeError as e:
            print(f"❌ JSON 설정 파싱 오류: {e}")
            print("올바른 형식: '[{\"identifier\": \"https://example.com\", \"maxItems\": 3}]'")
            sys.exit(1)

        # 브라우저 모드 설정
        headless_mode = args.headless and not args.show_browser
        if args.show_browser:
            print("🖥️ 브라우저 창 표시 모드")
        
        print(f"""
🚀 크롤링 시작
{'='*60}
📊 설정 정보:
   • 대상 사이트: {len(sources_config_list)}개
   • 시간 범위: {args.timeframe_hours}시간
   • 대상 날짜: {args.target_date or '제한 없음'}
   • 관심 키워드: {args.content_focus or '제한 없음'}
   • 결과 파일: {args.output}
   • 브라우저 모드: {'헤드리스' if headless_mode else '표시'}
{'='*60}
        """)

        # 크롤러 초기화
        crawler = DynamicCrawler(
            llm_provider=args.llm_provider,
            headless=headless_mode,
            target_date=args.target_date
        )
        
        try:
            await crawler.initialize()
            print("✅ 크롤러 초기화 완료")
        except Exception as e:
            print(f"❌ 크롤러 초기화 실패: {e}")
            sys.exit(1)
        
        all_results = []
        successful_sites = 0
        total_stories = 0
        
        # 각 사이트 처리
        for i, source_config_item in enumerate(sources_config_list, 1):
            url = source_config_item.get("identifier") or source_config_item.get("url")
            max_links_for_source = source_config_item.get("max_items", source_config_item.get("maxItems", 1))
            
            if not url:
                print(f"⚠️ 사이트 {i}: URL 누락, 건너뜀 - {source_config_item}")
                continue

            print(f"""
📍 사이트 {i}/{len(sources_config_list)} 처리 중
   • URL: {url}
   • 최대 링크: {max_links_for_source}개
   • 시간 범위: {args.timeframe_hours}시간
""")
            
            try:
                result_obj = await crawler.crawl_url_targeted(
                    url=url,
                    content_focus=args.content_focus,
                    max_links=max_links_for_source,
                    timeframe_hours_for_filter=args.timeframe_hours 
                )
                
                all_results.append(result_obj.to_dict())
                
                # 결과 요약
                stories_count = len(result_obj.stories)
                if stories_count > 0:
                    successful_sites += 1
                    total_stories += stories_count
                    print(f"✅ 사이트 {i} 완료: {stories_count}개 기사 수집")
                    
                    # 수집된 기사 간단 요약 (소스 정보 포함)
                    for j, story in enumerate(result_obj.stories, 1):
                        print(f"   {j}. {story.headline[:50]}... (출처: {story.source})")
                else:
                    print(f"⚠️ 사이트 {i} 완료: 수집된 기사 없음")
                    if result_obj.error:
                        print(f"   오류: {result_obj.error}")
                
            except Exception as e:
                print(f"❌ 사이트 {i} 처리 실패: {str(e)}")
                # 실패한 경우에도 빈 결과 추가
                all_results.append(CrawlResult(url).to_dict())
            
            # 다음 사이트 처리 전 대기 (마지막 사이트가 아닌 경우)
            if i < len(sources_config_list):
                delay = min(5, max(2, len(sources_config_list) - i))  # 동적 대기 시간
                print(f"⏳ {delay}초 대기 후 다음 사이트 처리...")
                await asyncio.sleep(delay)
        
        await crawler.close()
        print("✅ 크롤러 종료 완료")
        
        # 결과 저장
        try:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(all_results, f, ensure_ascii=False, indent=2)
            print(f"✅ 결과 저장 완료: {args.output}")
        except Exception as e:
            print(f"❌ 결과 저장 실패: {e}")
            # 백업 파일명으로 저장 시도
            backup_file = f"crawl_results_backup_{int(time.time())}.json"
            try:
                with open(backup_file, 'w', encoding='utf-8') as f:
                    json.dump(all_results, f, ensure_ascii=False, indent=2)
                print(f"✅ 백업 파일로 저장: {backup_file}")
            except Exception as backup_error:
                print(f"❌ 백업 저장도 실패: {backup_error}")
        
        # 최종 요약 출력
        end_time = time.time()
        duration = end_time - start_time
        
        print(f"""
🎉 크롤링 완료!
{'='*60}
📊 최종 결과:
   • 처리된 사이트: {len(sources_config_list)}개
   • 성공한 사이트: {successful_sites}개
   • 총 수집 기사: {total_stories}개
   • 소요 시간: {duration:.1f}초
   • 평균 처리 시간: {duration/len(sources_config_list):.1f}초/사이트
   • 결과 파일: {args.output}
{'='*60}

📈 사이트별 상세 결과:""")
        
        for i, (source_config, result) in enumerate(zip(sources_config_list, all_results), 1):
            url = source_config.get("identifier") or source_config.get("url", "Unknown")
            stories_count = len(result.get('stories', []))
            site_info = result.get('site_info', {})
            platform = site_info.get('platform', 'unknown')
            cms = site_info.get('cms', 'unknown')
            
            status = "✅" if stories_count > 0 else ("⚠️" if result.get('error') else "❌")
            print(f"   {status} 사이트 {i}: {stories_count}개 기사")
            print(f"      URL: {url}")
            print(f"      유형: {platform}/{cms}")
            if result.get('error'):
                print(f"      오류: {result['error']}")
        
        if total_stories == 0:
            print("\n⚠️ 수집된 기사가 없습니다. 다음을 확인해보세요:")
            print("   📊 진단 및 개선 방안:")
            print("   1. URL 접근성:")
            print("      • URL이 올바른지 확인")
            print("      • 사이트가 접근 가능한지 확인 (방화벽, 지역 차단 등)")
            print("      • HTTPS/HTTP 프로토콜 확인")
            print("   2. 시간 설정:")
            print("      • --timeframe_hours를 72 또는 168(일주일)로 늘려보세요")
            print("      • --target_date 설정을 제거하거나 조정해보세요")
            print("   3. 콘텐츠 필터:")
            print("      • --content_focus 키워드를 단순화하거나 제거해보세요")
            print("      • 'AI' 대신 'tech' 또는 'technology' 등 더 넓은 키워드 사용")
            print("   4. 사이트별 특성:")
            print("      • 일부 사이트는 JavaScript가 많이 필요할 수 있습니다")
            print("      • --show-browser 옵션으로 실제 페이지 로딩 상태 확인")
            print("   5. 디버깅:")
            print("      • 개별 사이트를 하나씩 테스트해보세요")
            print("      • 브라우저에서 직접 사이트를 방문하여 구조 확인")
            print("   6. 대안 설정:")
            print("      • max_items를 더 늘려보세요 (3-5개)")
            print("      • 다른 비슷한 사이트들도 추가해보세요")
            
            # 실행된 설정 요약
            print(f"\n📋 실행된 설정 요약:")
            print(f"   • 처리 사이트: {len(sources_config_list)}개")
            for i, config in enumerate(sources_config_list, 1):
                url = config.get("identifier") or config.get("url", "Unknown")
                max_items = config.get("max_items", config.get("maxItems", 1))
                print(f"     {i}. {url} (최대 {max_items}개)")
            print(f"   • 시간 범위: {args.timeframe_hours}시간")
            print(f"   • 대상 날짜: {args.target_date or '제한 없음'}")
            print(f"   • 관심 키워드: {args.content_focus or '제한 없음'}")
            
            # 추천 명령어
            print(f"\n🔧 추천 재실행 명령어:")
            print(f"   # 더 관대한 시간 설정:")
            print(f"   python dynamic_crawl.py --sources_config '{args.sources_config}' --timeframe_hours 168")
            print(f"   # 키워드 필터 제거:")
            print(f"   python dynamic_crawl.py --sources_config '{args.sources_config}' --timeframe_hours 72")
            print(f"   # 브라우저 표시 모드로 디버깅:")
            print(f"   python dynamic_crawl.py --sources_config '{args.sources_config}' --show-browser")
        
        else:
            print(f"\n🎉 수집 성공! 총 {total_stories}개의 최신 AI/기술 관련 기사를 찾았습니다.")
            print("📰 다음 단계: 수집된 데이터를 분석하고 요약 생성")
        
        return all_results
        
    except KeyboardInterrupt:
        print("\n⚠️ 사용자에 의해 중단되었습니다.")
        sys.exit(1)
    except Exception as e:
        print(f"❌ 예상치 못한 오류: {str(e)}")
        import traceback
        print("\n🔍 상세 오류 정보:")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main()) 