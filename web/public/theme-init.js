(function () {
  try {
    var mode = localStorage.getItem('nc-theme');
    var dark =
      mode === 'dark' ||
      (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (error) {
    /* 隐私模式下 localStorage 不可用时使用浅色默认值 */
  }
})();
