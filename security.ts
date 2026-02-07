export function displayUserContent(content) {
  // Vulnerable: directly inserting user content into DOM
  document.getElementById('content-display').innerHTML = content;
}