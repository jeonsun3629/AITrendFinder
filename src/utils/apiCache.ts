import crypto from 'crypto';

// 캐시 항목의 유효시간 (1시간)
const CACHE_TTL = 60 * 60 * 1000;

// 캐시 항목 인터페이스
interface CacheItem<T> {
  value: T;
  expiry: number;
}

// 캐시 저장소
export class ApiCache {
  private static cache: Map<string, CacheItem<any>> = new Map();

  /**
   * 캐시에서 값을 가져옵니다.
   * @param key 캐시 키
   * @returns 캐시된 값 또는 undefined
   */
  static get<T>(key: string): T | undefined {
    const cacheKey = this.hashKey(key);
    const item = this.cache.get(cacheKey);
    
    // 캐시 항목이 없거나 만료된 경우
    if (!item || item.expiry < Date.now()) {
      if (item) {
        this.cache.delete(cacheKey); // 만료된 항목 제거
      }
      return undefined;
    }
    
    return item.value as T;
  }

  /**
   * 값을 캐시에 저장합니다.
   * @param key 캐시 키
   * @param value 저장할 값
   * @param ttl 캐시 유효시간 (밀리초, 기본값 1시간)
   */
  static set<T>(key: string, value: T, ttl: number = CACHE_TTL): void {
    const cacheKey = this.hashKey(key);
    const expiry = Date.now() + ttl;
    this.cache.set(cacheKey, { value, expiry });
  }

  /**
   * 캐시를 비웁니다.
   */
  static clear(): void {
    this.cache.clear();
  }

  /**
   * 만료된 캐시 항목을 제거합니다.
   */
  static cleanExpired(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (item.expiry < now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 캐시의 크기를 확인합니다.
   */
  static size(): number {
    return this.cache.size;
  }

  /**
   * 캐시 키를 해시합니다.
   * @param key 원본 키
   * @returns 해시된 키
   */
  private static hashKey(key: string): string {
    return crypto.createHash('md5').update(key).digest('hex');
  }
}

/**
 * 캐시에서 아이템을 가져옵니다.
 * @param key 캐시 키
 * @param defaultValue 기본값 (캐시에 없을 경우 반환)
 * @returns 캐시된 값 또는 기본값
 */
export function getCacheItem<T>(key: string, defaultValue?: T): T | undefined {
  return ApiCache.get<T>(key) || defaultValue;
}

/**
 * 아이템을 캐시에 저장합니다.
 * @param key 캐시 키
 * @param value 저장할 값
 * @param ttl 캐시 유효시간 (밀리초)
 */
export function setCacheItem<T>(key: string, value: T, ttl?: number): void {
  ApiCache.set(key, value, ttl);
}

/**
 * 함수 실행 결과를 캐싱하는 래퍼 함수
 * @param fn 캐싱할 함수
 * @param keyPrefix 캐시 키 접두사
 * @param ttl 캐시 유효시간 (밀리초)
 * @returns 래핑된 함수
 */
export function withCache<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>,
  keyPrefix: string = '',
  ttl: number = CACHE_TTL
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    // 인자를 포함한 캐시 키 생성
    const key = `${keyPrefix}:${JSON.stringify(args)}`;
    
    // 캐시에서 결과 확인
    const cachedResult = ApiCache.get<T>(key);
    if (cachedResult !== undefined) {
      console.log(`[캐시 적중] ${keyPrefix}`);
      return cachedResult;
    }
    
    // 캐시에 없으면 함수 실행
    console.log(`[캐시 미스] ${keyPrefix}`);
    const result = await fn(...args);
    
    // 결과를 캐시에 저장
    ApiCache.set(key, result, ttl);
    
    return result;
  };
}

// 정기적으로 만료된 캐시 항목 정리 (1시간마다)
setInterval(() => {
  ApiCache.cleanExpired();
}, CACHE_TTL); 