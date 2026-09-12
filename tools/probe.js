(() => {
  const v = document.querySelector('foliate-view');
  return {
    title: v?.book?.metadata?.title ?? null,
    sections: v?.book?.sections?.length ?? null,
    contents: v?.renderer?.getContents?.()?.length ?? null,
    toolbar: document.body.innerText.slice(0, 200),
    buttons: [...document.querySelectorAll('button')].slice(0, 4).map(b => b.textContent),
  };
})()