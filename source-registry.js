const SOURCES = [
  {
    id: "iptv_org_russian",
    name: "IPTV-org Russian",
    type: "m3u",
    url: "https://iptv-org.github.io/iptv/languages/rus.m3u",
    priority: 100,
    enabled: true
  },
  {
    id: "iptv_org_kazakhstan",
    name: "IPTV-org Kazakhstan",
    type: "m3u",
    url: "https://iptv-org.github.io/iptv/countries/kz.m3u",
    priority: 110,
    enabled: true
  },
  {
    id: "iptv_org_russia",
    name: "IPTV-org Russia",
    type: "m3u",
    url: "https://iptv-org.github.io/iptv/countries/ru.m3u",
    priority: 100,
    enabled: true
  },
  {
    id: "free_tv",
    name: "Free-TV IPTV",
    type: "m3u",
    url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
    priority: 80,
    enabled: true
  }
];

module.exports = SOURCES;
