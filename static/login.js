document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const response = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:document.querySelector('#password').value})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const returnTo = new URLSearchParams(location.search).get('return') || '/';
    const target = new URL(returnTo, location.origin);
    location.replace(target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : '/');
  } catch (error) { document.querySelector('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
