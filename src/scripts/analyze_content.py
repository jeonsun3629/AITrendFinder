import sys
import json
import os
from typing import Dict, List, Optional, Tuple, Any

# 필요한 라이브러리 동적 설치
def ensure_installed(package: str) -> None:
    try:
        __import__(package)
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

# 필요한 패키지 설치
ensure_installed("openai")
ensure_installed("numpy")
ensure_installed("tiktoken")

# 설치 후 임포트
import openai
import numpy as np
import tiktoken
from openai import OpenAI

# API 키 설정
openai.api_key = os.environ.get("OPENAI_API_KEY", "")

# 명령줄 인자로 전달된 데이터 처리
try:
    input_data = {
        "content": sys.argv[1],
        "categories": json.loads(sys.argv[2]),
        "llmProvider": sys.argv[3],
        "model": sys.argv[4]
    }
except (IndexError, json.JSONDecodeError) as e:
    print(f"입력 인자 처리 오류: {str(e)}")
    sys.exit(1)

# 콘텐츠 텍스트 토큰화
def count_tokens(text: str) -> int:
    try:
        encoding = tiktoken.encoding_for_model("gpt-4o")
        return len(encoding.encode(text))
    except:
        # 단순 추정 (토큰화 실패 시)
        return len(text) // 4

# 임베딩 생성
def get_embedding(text: str, model: str = "text-embedding-3-small") -> list:
    # 토큰 제한 확인 (8191 토큰으로 제한)
    token_count = count_tokens(text)
    if token_count > 8000:
        # 토큰 수가 너무 많으면 텍스트 축소
        ratio = 8000 / token_count
        text = text[:int(len(text) * ratio)]
    
    client = OpenAI()
    response = client.embeddings.create(
        input=text,
        model=model
    )
    return response.data[0].embedding

# 카테고리별 대표 키워드
category_keywords = {
    "모델 업데이트": [
        "새로운 모델", "성능 향상", "토큰 최적화", "추론 속도", "파라미터 규모",
        "오픈 웨이트", "파인튜닝", "새 버전", "컨텍스트 길이", "다중모달"
    ],
    "연구 동향": [
        "논문", "연구 결과", "새로운 방법론", "벤치마크", "실험 결과",
        "알고리즘", "데이터셋", "평가 지표", "성능 개선", "혁신적 접근"
    ],
    "시장 동향": [
        "시장 점유율", "투자", "인수", "합병", "시리즈 펀딩",
        "기업 가치", "비즈니스 모델", "제품 출시", "사업 전략", "경쟁 분석"
    ],
    "개발자 도구": [
        "SDK", "API", "툴킷", "프레임워크", "라이브러리",
        "개발 환경", "플러그인", "코드 예제", "배포 도구", "개발자 리소스"
    ],
    "산업 응용": [
        "산업 사례", "적용 분야", "실제 구현", "사용자 피드백", "성공 사례",
        "도메인 특화", "의료 AI", "금융 AI", "교육 AI", "로봇 적용"
    ],
    "윤리 및 규제": [
        "AI 윤리", "규제 프레임워크", "책임감 있는 AI", "공정성", "투명성",
        "편향 완화", "안전 조치", "법적 고려사항", "정책 변화", "윤리적 가이드라인"
    ],
    "오픈 소스": [
        "오픈소스 프로젝트", "커뮤니티 기여", "라이선스", "깃허브", "코드 공유",
        "협업 개발", "오픈 표준", "커뮤니티 지원", "풀 리퀘스트", "코드베이스"
    ],
    "기초 연구": [
        "이론적 기반", "수학적 모델", "원리 연구", "개념 증명", "기초 과학",
        "이론적 한계", "연구 방향성", "학문적 영향", "기본 원칙", "과학적 발견"
    ],
    "General": [
        "AI", "ML", "인공지능", "기계학습", "딥러닝",
        "신경망", "기술", "혁신", "발전", "미래"
    ]
}

# 사용자 정의 카테고리가 있는 경우 적용
custom_categories = input_data.get("categories", [])
if custom_categories:
    # 사용자 정의 카테고리에 맞게 키워드 맵 조정
    for category in custom_categories:
        if category not in category_keywords:
            # 새 카테고리의 경우 기본 키워드 생성
            category_keywords[category] = [category, category.lower()] + category.split()

# 콘텐츠에서 카테고리별 키워드 매칭 점수 계산
def get_keyword_matches(content: str) -> Dict[str, Dict[str, int]]:
    content_lower = content.lower()
    results = {}
    
    for category, keywords in category_keywords.items():
        category_matches = {}
        for keyword in keywords:
            keyword_lower = keyword.lower()
            count = content_lower.count(keyword_lower)
            if count > 0:
                category_matches[keyword] = count
        
        if category_matches:
            results[category] = category_matches
    
    return results

# 콘텐츠와 카테고리 간의 의미적 유사성 계산
def calculate_semantic_similarity(content_embedding: list, categories: list) -> Dict[str, float]:
    # 각 카테고리에 대한 임베딩 생성
    category_embeddings = {}
    for category in categories:
        # 카테고리 설명 생성
        category_description = f"{category}. {', '.join(category_keywords.get(category, [category]))}"
        category_embedding = get_embedding(category_description)
        category_embeddings[category] = category_embedding
    
    # 콘텐츠와 각 카테고리 간의 코사인 유사도 계산
    similarities = {}
    for category, embedding in category_embeddings.items():
        similarity = np.dot(content_embedding, embedding) / (np.linalg.norm(content_embedding) * np.linalg.norm(embedding))
        similarities[category] = float(similarity)
    
    return similarities

# LLM을 사용한 고급 카테고리 분석
def analyze_with_llm(content: str, categories: list) -> Dict[str, Any]:
    client = OpenAI()
    model = input_data.get("model", "gpt-4o-mini")
    
    # 프롬프트 구성
    categories_str = ', '.join(categories)
    prompt = f"""다음 콘텐츠를 분석하고 가장 적합한 카테고리를 결정해주세요. 
가능한 카테고리: {categories_str}

콘텐츠:
{content[:4000]}

분석 방법:
1. 각 카테고리에 얼마나 부합하는지 평가해주세요.
2. 가장 적합한 카테고리와 그 확신도(0.0-1.0)를 제공해주세요.
3. 관련된 하위 주제나 키워드를 식별해주세요.

다음 JSON 형식으로 응답해주세요:
```json
{{
  "mainCategory": "가장 적합한 카테고리",
  "confidence": 0.85, 
  "subCategories": ["관련 하위 카테고리1", "관련 하위 카테고리2"], 
  "relatedTopics": ["관련 주제1", "관련 주제2", "관련 주제3"], 
  "reasoning": "이 카테고리로 분류한 이유에 대한 간략한 설명"
}}
```
"""
    
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "당신은 AI 및 기계학습 관련 콘텐츠를 분석하고 분류하는 전문가입니다."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            response_format={"type": "json_object"}
        )
        
        response_text = response.choices[0].message.content
        result = json.loads(response_text)
        return result
    except Exception as e:
        print(f"LLM 분석 오류: {str(e)}")
        return {
            "mainCategory": categories[0] if categories else "General",
            "confidence": 0.5,
            "subCategories": [],
            "relatedTopics": [],
            "reasoning": "LLM 분석 중 오류 발생"
        }

# 주요 분석 함수
def analyze_content():
    content = input_data["content"]
    categories_to_analyze = input_data.get("categories", list(category_keywords.keys()))
    
    if not categories_to_analyze:
        categories_to_analyze = ["General"]
    
    # 1. 콘텐츠에서 키워드 매칭 확인
    keyword_matches = get_keyword_matches(content)
    
    # 2. 임베딩 기반 의미론적 유사성 분석
    try:
        content_embedding = get_embedding(content)
        semantic_similarities = calculate_semantic_similarity(content_embedding, categories_to_analyze)
    except Exception as e:
        print(f"임베딩 분석 오류: {str(e)}")
        semantic_similarities = {category: 0.5 for category in categories_to_analyze}
    
    # 3. LLM 기반 고급 분석
    llm_analysis = analyze_with_llm(content, categories_to_analyze)
    
    # 4. 결과 결합
    main_category = llm_analysis.get("mainCategory", categories_to_analyze[0])
    confidence = llm_analysis.get("confidence", 0.7)
    
    # 키워드 매칭 점수 반영
    keyword_score = {}
    for category, matches in keyword_matches.items():
        keyword_score[category] = sum(matches.values())
    
    # 최종 결과 구성
    final_result = {
        "category": main_category,
        "confidence": confidence,
        "subCategories": llm_analysis.get("subCategories", []),
        "relatedTopics": llm_analysis.get("relatedTopics", []),
        "semanticSimilarities": semantic_similarities,
        "keywordMatches": keyword_matches,
        "reasoning": llm_analysis.get("reasoning", "")
    }
    
    return final_result

# 메인 실행
try:
    result = analyze_content()
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    # 오류 발생 시 기본 카테고리 반환 (JavaScript에서 처리 가능)
    error_result = {
        "category": "연구 동향",
        "confidence": 0.5,
        "subCategories": [],
        "relatedTopics": [],
        "error": str(e)
    }
    print(json.dumps(error_result, ensure_ascii=False))
    sys.exit(1) 