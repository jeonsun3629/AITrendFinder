document.addEventListener('DOMContentLoaded', function() {
    // 카드 애니메이션 효과
    const cards = document.querySelectorAll('.card');
    
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.classList.add('card-hover');
        });
        
        card.addEventListener('mouseleave', function() {
            this.classList.remove('card-hover');
        });
    });

    // 섹션 스크롤 애니메이션
    const sections = document.querySelectorAll('section');
    
    const fadeInOptions = {
        threshold: 0.1,
        rootMargin: "0px 0px -100px 0px"
    };
    
    const fadeInOnScroll = new IntersectionObserver(function(entries, fadeInOnScroll) {
        entries.forEach(entry => {
            if (!entry.isIntersecting) {
                return;
            } else {
                entry.target.classList.add('fade-in');
                fadeInOnScroll.unobserve(entry.target);
            }
        });
    }, fadeInOptions);
    
    sections.forEach(section => {
        section.classList.add('fade-out');
        fadeInOnScroll.observe(section);
    });

    // 모바일 메뉴 토글
    const createMobileMenu = () => {
        const header = document.querySelector('header');
        const menuButton = document.createElement('button');
        menuButton.classList.add('menu-toggle');
        menuButton.innerHTML = '<i class="fas fa-bars"></i>';
        
        const nav = document.createElement('nav');
        nav.classList.add('main-nav');
        nav.classList.add('hidden');
        
        const sections = ['인트로', '하이라이트', '모델', '연구', '디스코드'];
        const sectionIds = ['intro', 'highlights', 'models', 'research', 'discord'];
        
        const ul = document.createElement('ul');
        
        sections.forEach((section, index) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = `#${sectionIds[index]}`;
            a.textContent = section;
            
            a.addEventListener('click', () => {
                nav.classList.add('hidden');
            });
            
            li.appendChild(a);
            ul.appendChild(li);
        });
        
        nav.appendChild(ul);
        
        menuButton.addEventListener('click', () => {
            nav.classList.toggle('hidden');
        });
        
        header.querySelector('.container').appendChild(menuButton);
        header.after(nav);
    };
    
    // 화면 너비가 모바일 크기일 때만 메뉴 생성
    if (window.innerWidth <= 768) {
        createMobileMenu();
    }
    
    window.addEventListener('resize', () => {
        const existingNav = document.querySelector('.main-nav');
        const existingButton = document.querySelector('.menu-toggle');
        
        if (window.innerWidth <= 768 && !existingNav) {
            createMobileMenu();
        } else if (window.innerWidth > 768 && existingNav) {
            existingNav.remove();
            existingButton.remove();
        }
    });
    
    // 스크롤 버튼 기능 설정 (이미 HTML에 있는 버튼 사용)
    const scrollToTopButton = document.querySelector('.scroll-to-top');
    
    // 스크롤 위치에 따라 버튼 표시/숨김
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            scrollToTopButton.classList.add('show');
        } else {
            scrollToTopButton.classList.remove('show');
        }
    });
    
    // 버튼 클릭 시 페이지 상단으로 스크롤
    scrollToTopButton.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
}); 