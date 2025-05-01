document.addEventListener('DOMContentLoaded', () => {
    const indexTextElement = document.getElementById('animated-index');
    const indexText = "Hi, I'm Allen!";
    const draftbearsTextElement = document.getElementById('animated-draftbears');
    const draftbearsText = "DraftBears Sportsbook";
    const iterativeTextElement = document.getElementById('animated-iterative');
    const iterativeText = "Sesame: Iterative Design";
    const redesignTextElement = document.getElementById('animated-redesign');
    const redesignText = "Responsive Redesign";
    const personasTextElement = document.getElementById('animated-personas');
    const personasText = "Personas and Storyboards";

    function animateText(textElement, text) {
        // Check if the element exists before trying to animate it
        if (!textElement) {
            console.warn(`Element not found for text: "${text}"`);
            return; // Skip animation if element doesn't exist
        }
        
        let index = 0;
        function type() {
            if (index < text.length) {
                textElement.innerHTML = text.substring(0, index + 1) + '<span class="blink">|</span>';
                index++;
                setTimeout(type, 100); // Adjust typing speed here
            }
        }
        console.log("Typing text: " + text);
        type();
        console.log("Done text: " + text);
    }

    console.log("Test statement: Animation starting...");
    animateText(indexTextElement, indexText);
    animateText(iterativeTextElement, iterativeText);
    animateText(draftbearsTextElement, draftbearsText);
    animateText(redesignTextElement, redesignText);
    animateText(personasTextElement, personasText);
});