#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
crawl4ai를 사용한 웹 크롤링 스크립트
이 스크립트는 GitHub Actions에서 실행되며, 
LLM 기반 자동 네비게이션을 사용하여 웹 사이트를 크롤링합니다.
"""

import os
import sys
import json
import asyncio
import argparse
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
import re

# 인코딩 설정
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    # 먼저 crawl4ai가 설치되어 있는지 확인
    import importlib.util
    crawler_spec = importlib.util.find_spec("crawl4ai")
    
    if crawler_spec is None:
        print("crawl4ai 라이브러리를 설치해주세요: pip install crawl4ai")
        sys.exit(1)
        
    from crawl4ai import AsyncWebCrawler, LLMConfig, BrowserConfig
    print(f"crawl4ai 버전: {importlib.import_module('crawl4ai').__version__}")
except ImportError as e:
    print(f"crawl4ai 라이브러리를 불러올 수 없습니다: {str(e)}")
    print("다음 명령어로 설치해주세요: pip install -U crawl4ai")
    sys.exit(1)
except Exception as e:
    print(f"crawl4ai 초기화 오류: {str(e)}")
    sys.exit(1)

def setup_argparse() -> argparse.Namespace:
    """커맨드 라인 인자 설정"""
    parser = argparse.ArgumentParser(description="crawl4ai를 사용한 웹 크롤링")
    parser.add_argument(
        "--sources", 
        type=str, 
        default="[]",
        help="크롤링할 소스 목록 (JSON 형식)"
    )
    parser.add_argument(
        "--output", 
        type=str, 
        default="crawl_results.json",
        help="결과 저장 파일 경로"
    )
    parser.add_argument(
        "--llm_provider", 
        type=str, 
        default="openai",
        choices=["openai", "together", "deepseek"],
        help="LLM 프로바이더"
    )
    parser.add_argument(
        "--max_items", 
        type=int, 
        default=3,
        help="각 소스에서 가져올 최대 아이템 수"
    )
    parser.add_argument(
        "--timeframe_hours", 
        type=int, 
        default=48,
        help="현재 시간으로부터 몇 시간 내의 컨텐츠만 가져올지 설정"
    )
    return parser.parse_args()

def setup_crawl4ai(llm_provider: str = "openai") -> AsyncWebCrawler:
    """crawl4ai 크롤러 설정"""
    
    # 환경 변수에서 API 키 가져오기
    api_token = None
    if llm_provider == "openai":
        api_token = os.getenv("OPENAI_API_KEY")
    elif llm_provider == "together":
        api_token = os.getenv("TOGETHER_API_KEY")
    elif llm_provider == "deepseek":
        api_token = os.getenv("DEEPSEEK_API_KEY")
    
    if not api_token:
        print(f"{llm_provider.upper()}_API_KEY 환경 변수가 설정되지 않았습니다.")
        sys.exit(1)
    
    print(f"LLM 프로바이더: {llm_provider}")
    
    # 최신 API에 맞게 provider 값 형식 변경
    provider = f"{llm_provider}/gpt-4" if llm_provider == "openai" else f"{llm_provider}/default"
    
    # LLM 설정 - 최신 API에 맞게 변경
    llm_config = LLMConfig(
        provider=provider,
        api_token=api_token
    )
    
    # 브라우저 설정 - 최소한의 설정으로 변경
    browser_config = BrowserConfig()  # 기본 설정 사용
    
    # 크롤러 생성 - 매개변수 이름 변경
    return AsyncWebCrawler(
        config=browser_config, 
        llm_config=llm_config
    )

async def crawl_source(crawler: AsyncWebCrawler, source: str, max_items: int = 1, timeframe_hours: int = 48) -> Dict[str, Any]:
    """단일 소스 크롤링"""
    print(f"크롤링 시작: {source} (최대 {max_items}개 항목, {timeframe_hours}시간 이내)")
    
    try:
        # 크롤링 수행 (비동기 함수로 변경, crawl → arun)
        result = await crawler.arun(
            url=source,
            # 최대 아이템 수와 시간 제한 적용
            extra_instructions=f"가장 최근에 발행된 글(최대 {timeframe_hours}시간 이내)만 가져와주세요. 최대 {max_items}개까지만 가져오세요."
        )
        
        # 결과 가공 - crawl4ai 0.6.3 API에 맞춰 수정
        stories = []
        
        # 현재 시간 설정 (날짜 필터링용)
        now = datetime.now()
        cutoff_time = now - timedelta(hours=timeframe_hours)
        print(f"현재 시간: {now.isoformat()}, 기준 시간: {cutoff_time.isoformat()} (최근 {timeframe_hours}시간)")
        
        if hasattr(result, 'markdown'):
            # 마크다운 결과가 있는 경우 (최신 API)
            content = result.markdown.fit_markdown or result.markdown.raw_markdown or ""
            metadata = getattr(result, 'metadata', {}) or {}
            
            story = {
                "headline": metadata.get("title", "제목 없음"),
                "link": source,
                "date_posted": metadata.get("published_date", datetime.now().isoformat()),
                "fullContent": content,
                "imageUrls": metadata.get("image_urls", []) if metadata.get("image_urls") else [],
                "videoUrls": metadata.get("video_urls", []) if metadata.get("video_urls") else [],
                "popularity": "N/A"
            }
            stories.append(story)
        elif hasattr(result, 'pages'):
            # 페이지 구조가 있는 경우
            for page in result.pages:
                metadata = getattr(page, 'metadata', {}) or {}
                content = getattr(page, 'content', "") or ""
                url = getattr(page, 'url', source) or source
                
                story = {
                    "headline": metadata.get("title", "제목 없음"),
                    "link": url,
                    "date_posted": metadata.get("published_date", datetime.now().isoformat()),
                    "fullContent": content,
                    "imageUrls": metadata.get("image_urls", []),
                    "videoUrls": metadata.get("video_urls", []),
                    "popularity": "N/A"
                }
                stories.append(story)
        elif hasattr(result, 'content'):
            # 단일 페이지 결과인 경우
            content = result.content or ""
            metadata = getattr(result, 'metadata', {}) or {}
            
            story = {
                "headline": metadata.get("title", "제목 없음"),
                "link": source,
                "date_posted": metadata.get("published_date", datetime.now().isoformat()),
                "fullContent": content,
                "imageUrls": metadata.get("image_urls", []),
                "videoUrls": metadata.get("video_urls", []),
                "popularity": "N/A"
            }
            stories.append(story)
        else:
            # 다른 구조인 경우
            print(f"알 수 없는 결과 구조: {type(result)}")
            story = {
                "headline": "제목 추출 실패",
                "link": source,
                "date_posted": datetime.now().isoformat(),
                "fullContent": str(result),
                "imageUrls": [],
                "videoUrls": [],
                "popularity": "N/A"
            }
            stories.append(story)
        
        # 결과 필터링: 최근 N시간 이내 & 최대 개수 제한
        filtered_stories = []
        for story in stories:
            # 날짜 파싱 시도
            is_recent = False
            try:
                date_str = story["date_posted"]
                
                # "X days ago" 패턴 처리
                days_ago_match = re.search(r'(\d+)\s*days?\s*ago', date_str, re.IGNORECASE)
                if days_ago_match:
                    days = int(days_ago_match.group(1))
                    print(f"날짜 '{date_str}'는 {days}일 전으로 파싱됨")
                    # timeframe_hours (예: 48시간) 이내인지 확인 (days * 24 <= timeframe_hours)
                    is_recent = days * 24 <= timeframe_hours 
                    if not is_recent:
                        print(f"{timeframe_hours}시간 초과 게시물 필터링: {story['headline']} ({date_str})")
                        continue
                
                # "X hours ago", "X minutes ago" 패턴 처리
                time_ago_match = re.search(r'(\d+)\s*(hour|hours|minute|minutes|min|mins)\s*ago', date_str, re.IGNORECASE)
                if time_ago_match:
                    amount = int(time_ago_match.group(1))
                    unit = time_ago_match.group(2).lower()
                    
                    if 'hour' in unit:
                        is_recent = amount <= timeframe_hours
                    else:  # minutes
                        is_recent = True  # 분 단위는 항상 최근
                    
                    if not is_recent:
                        print(f"시간 초과 게시물 필터링: {story['headline']} ({date_str})")
                        continue
                
                # 날짜 형식 직접 파싱 시도
                try:
                    # 다양한 날짜 형식 시도
                    for date_format in [
                        '%Y-%m-%d', '%Y/%m/%d', '%b %d, %Y', '%B %d, %Y',
                        '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'
                    ]:
                        try:
                            story_date = datetime.strptime(date_str, date_format)
                            if (now - story_date).total_seconds() <= timeframe_hours * 3600:
                                is_recent = True
                            break
                        except ValueError:
                            continue
                except Exception as date_error:
                    print(f"날짜 파싱 오류: {date_error}")
                
                # 날짜 확인 불가 또는 충분히 최근이 아닌 경우
                if not is_recent:
                    print(f"날짜 필터링: {story['headline']} ({date_str})")
                    continue
            except Exception as e:
                print(f"날짜 처리 오류: {str(e)}")
                # 날짜 처리 오류 시 안전을 위해 포함 (JavaScript에서 다시 필터링)
            
            filtered_stories.append(story)
        
        # 최대 아이템 수 제한
        if len(filtered_stories) > max_items:
            print(f"{len(filtered_stories)}개 스토리를 {max_items}개로 제한합니다.")
            filtered_stories = filtered_stories[:max_items]
        
        print(f"최종 선택된 스토리: {len(filtered_stories)}개")
        for i, story in enumerate(filtered_stories):
            print(f"  {i+1}. '{story['headline']}' ({story['date_posted']})")
        
        return {
            "source": source,
            "stories": filtered_stories
        }
        
    except Exception as e:
        print(f"크롤링 오류 ({source}): {str(e)}")
        return {
            "source": source,
            "stories": [],
            "error": str(e)
        }

async def main_async():
    """비동기 메인 함수"""
    args = setup_argparse()
    
    try:
        # 소스 목록 파싱
        sources = json.loads(args.sources)
        if not isinstance(sources, list) or len(sources) == 0:
            print("유효한 소스가 제공되지 않았습니다. 기본 소스를 사용합니다.")
            sources = ["https://openai.com/blog"]
        
        # 최대 아이템 수 및 시간 제한 설정
        max_items = int(args.max_items)
        timeframe_hours = int(args.timeframe_hours)
        
        print(f"처리할 소스: {sources}")
        print(f"설정: 최대 {max_items}개 항목, {timeframe_hours}시간 이내")
        
        # crawl4ai 크롤러 설정
        crawler = setup_crawl4ai(args.llm_provider)
        
        # 모든 소스 결과를 저장할 배열
        all_results = []
        
        # 모든 소스를 순차적으로 처리
        for source in sources:
            print(f"\n===== 소스 처리 중: {source} =====")
            result = await crawl_source(crawler, source, max_items, timeframe_hours)
            all_results.append(result)
            
            # 소스 사이에 약간의 지연 추가
            if source != sources[-1]:  # 마지막 소스가 아니면
                delay = 5  # 5초 지연
                print(f"다음 소스 처리 전 {delay}초 대기...")
                await asyncio.sleep(delay)
        
        # 결과 저장
        output_path = args.output
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)
        
        print(f"크롤링 완료! 결과가 {output_path}에 저장되었습니다.")
        
        # 총 스토리 수 계산
        total_stories = sum(len(result["stories"]) for result in all_results)
        print(f"총 {len(sources)}개 소스에서 {total_stories}개의 스토리를 찾았습니다.")
        
    except Exception as e:
        print(f"오류 발생: {str(e)}")
        sys.exit(1)

def main():
    """메인 함수 - 비동기 메인 함수를 실행"""
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n사용자에 의해 크롤링이 중단되었습니다.")
        sys.exit(0)
    except Exception as e:
        print(f"실행 오류: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main() 