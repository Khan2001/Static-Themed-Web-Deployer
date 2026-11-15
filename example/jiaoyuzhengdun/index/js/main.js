// 教育动态轮播图：自动播放 + 左右切换 + 圆点导航
// 增删轮播图：直接在 index.html 的 .carousel-track 内添加/删除 .carousel-slide 即可
(function () {
  var track = document.querySelector(".carousel-track");
  if (!track) return;

  var slides = track.children;
  var dotsBox = document.querySelector(".carousel-dots");
  var index = 0;
  var timer = null;
  var DELAY = 4000;

  for (var i = 0; i < slides.length; i++) {
    var dot = document.createElement("span");
    dot.dataset.index = i;
    if (i === 0) dot.className = "active";
    dotsBox.appendChild(dot);
  }

  var dots = dotsBox.children;

  function go(to) {
    index = (to + slides.length) % slides.length;
    track.style.transform = "translateX(-" + index * 100 + "%)";
    for (var i = 0; i < dots.length; i++) {
      dots[i].className = i === index ? "active" : "";
    }
  }

  function restart() {
    clearInterval(timer);
    timer = setInterval(function () { go(index + 1); }, DELAY);
  }

  document.querySelector(".carousel-btn.prev").addEventListener("click", function () {
    go(index - 1);
    restart();
  });
  document.querySelector(".carousel-btn.next").addEventListener("click", function () {
    go(index + 1);
    restart();
  });
  dotsBox.addEventListener("click", function (e) {
    if (e.target.dataset.index !== undefined) {
      go(Number(e.target.dataset.index));
      restart();
    }
  });

  var carousel = document.querySelector(".carousel");
  carousel.addEventListener("mouseenter", function () { clearInterval(timer); });
  carousel.addEventListener("mouseleave", restart);

  restart();
})();
