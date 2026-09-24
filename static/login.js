document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const response = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:document.querySelector('#password').value})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.replace('/');
  } catch (error) { document.querySelector('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
