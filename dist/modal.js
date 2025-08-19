// modal.js
export const modalContainer = document.getElementById("modal-container");

export function openModal(contentHTML) {
  closeModal(); // Only one open at a time
  const modal = document.createElement("div");
  modal.classList.add("modal");
  modal.innerHTML = `
    <div class="modal-content">
      ${contentHTML}
      <button class="close-btn">Close</button>
    </div>
  `;
  modal.querySelector(".close-btn").onclick = () => closeModal();
  modal.onclick = e => {
    if (e.target === modal) closeModal();
  };
  modalContainer.appendChild(modal);
  document.body.classList.add("modal-open");
}

export function closeModal() {
  modalContainer.innerHTML = "";
  document.body.classList.remove("modal-open");
}
