/**
 * File: ui/app/utils/useTheme.js
 * Description: Composable for managing application theme state (light/dark/auto)
 *
 * Author: bbbugg
 */

import { ref, watchEffect } from 'vue';

const theme = ref('light');

/**
 * Global theme application logic.
 * Locked to light theme per design requirements.
 */
watchEffect(() => {
    const htmlEl = document.documentElement;
    htmlEl.setAttribute('data-theme', 'light');
    htmlEl.classList.remove('dark');

    const faviconLink = document.querySelector('link[rel="icon"]');
    if (faviconLink) {
        faviconLink.href = '/AIStudio_logo.svg';
    }

    localStorage.setItem('theme', 'light');
});

export function useTheme() {
    const setTheme = () => {
        theme.value = 'light';
    };

    return {
        setTheme,
        theme,
    };
}
