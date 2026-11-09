document.addEventListener('DOMContentLoaded', () => {
    const titles = {
        'animated-index': "Hi, I'm Allen!",
        'animated-draftbears': 'DraftBears Sportsbook',
        'animated-iterative': 'Sesame: Iterative Design',
        'animated-redesign': 'Responsive Redesign',
        'animated-personas': 'Personas and Storyboards',
        'animated-reai': 'Reintegrating AI',
        'animated-nlp': "L'Union Fait La Force",
        'animated-chicago': 'Chicago TODO Map',
        'animated-travel': 'AI Travel Planner',
    };

    for (const [id, text] of Object.entries(titles)) {
        const element = document.getElementById(id);
        if (!element) continue;
        let index = 0;
        function type() {
            if (index >= text.length) return;
            element.textContent = text.slice(0, ++index);
            const cursor = document.createElement('span');
            cursor.className = 'blink';
            cursor.textContent = '|';
            element.appendChild(cursor);
            setTimeout(type, 100);
        }
        type();
    }
});
