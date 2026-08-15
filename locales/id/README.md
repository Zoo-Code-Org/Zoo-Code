<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Butuh bantuan cepat → <a href="https://discord.gg/VxfP4Vx3gX">Gabung ke Discord</a> • Lebih suka async? → <a href="https://www.reddit.com/r/ZooCode/">Gabung ke r/ZooCode</a></em>
        </p>

        # Zoo Code

        > Tim dev bertenaga AI-mu, langsung di editor kamu

        ## Kami adalah Zoo Code

> Zoo Code melanjutkan pengembangan proyek ini setelah tim Roo menghentikan
> pengembangan aktif Roo Code untuk fokus pada [Roomote](https://roomote.dev/).
> Terima kasih kepada tim Roo atas semua yang telah mereka bangun.
>
> Tim inti kami terdiri dari para developer yang sebelumnya pernah
> berkontribusi ke Roo dan sangat peduli pada plugin ini. Kami akan terus
> menghadirkan pembaruan model, memperbaiki bug, dan merilis fitur, dan kami
> berencana untuk mendengarkan dengan saksama komunitas yang membuat plugin
> ini begitu istimewa. Gabung bersama kami di
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), atau
> [buka PR atau issue](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Migrasi dari Roo Code ke Zoo Code

Kamu bisa menemukan panduan singkat untuk berpindah dari Roo Code ke Zoo Code di [panduan migrasi Roo→Zoo](https://docs.zoocode.dev/roo-to-zoo-migration). Kami ingin membantu pengguna semaksimal mungkin selama masa transisi, dan itulah gunanya [Reddit](https://www.reddit.com/r/ZooCode) dan [Discord](https://discord.gg/VxfP4Vx3gX) kami. Kalau kamu mengalami masalah atau punya pertanyaan, langsung mampir dan tanya.

## Yang Ditambahkan Zoo Code Sejak Roo Code

Zoo Code dikembangkan di atas fondasi yang dibuat oleh Roo Code dan terus memperluasnya dengan:

- **Kecerdasan codebase Semble** — pencarian kode semantik yang cepat dan sesuai permintaan, dengan penyiapan otomatis dan tanpa workflow pengindeksan terpisah.
- **Workflow Orchestrator yang lebih kuat** — delegasi yang lebih aman, koordinasi task paralel, pemulihan task induk/anak yang andal, serta isolasi yang lebih baik antara subtask dan profil provider.
- **Proses otonom yang lebih panjang dengan Destructive Command Guard (DCG)** — memblokir perintah berbahaya secara otomatis sementara pekerjaan tepercaya terus berjalan tanpa permintaan persetujuan berulang.
- **Model terbaru** — dukungan berkelanjutan untuk keluarga model Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax, dan lainnya.
- **Lebih banyak cara untuk terhubung** — provider baru dan yang diperluas, termasuk Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go, dan banyak lagi.
- **Workflow terminal dan pengeditan yang lebih andal** — perbaikan untuk terminal yang selesai terlalu dini, race condition status task, pengelolaan konteks, pengeditan diff, dan penggunaan tool khusus provider.
- **Kontrol lebih besar atas workspace kamu** — pengelolaan rules, pembatasan MCP per mode, kontrol path multi-root, opsi reasoning model, dan tindakan untuk meninjau perubahan saat selesai.

## Yang Baru di v3.78.0

- **Tiga model baru utama telah hadir** — gunakan model terbaru Gemini 3.7 Flash, GLM 5.3, dan Qwen3.8 Max, ditambah pembaruan reasoning, harga, dan cakupan provider DeepSeek V4.
- **Hubungkan ke NanoGPT** — gunakan penemuan model dinamis, streaming dan penyelesaian prompt, serta preferensi routing untuk kecepatan, harga, latensi, throughput, dukungan tool, dan caching.
- **Provider dan task yang lebih andal** — perbaikan meningkatkan pengaturan endpoint Azure OpenAI, batas output Kimi Code, penyimpanan judul riwayat task, serta impor/ekspor pengaturan Zoo.
- Destructive Command Guard kini mendukung Mac berbasis Intel.
- Pembaruan keamanan mengatasi kerentanan di `undici` dan Mermaid.

## Apa yang Bisa Zoo Code Lakukan Untuk ANDA?

- Menghasilkan Kode dari deskripsi bahasa alami
- Beradaptasi dengan Mode: Kode, Arsitek, Tanya, Debug, dan Mode Kustom
- Refactor & Debug kode yang ada
- Menulis & Memperbarui dokumentasi
- Menjawab Pertanyaan tentang basis kode Anda
- Mengotomatiskan tugas-tugas yang berulang
- Memanfaatkan Server MCP

## Mode

Zoo Code beradaptasi dengan cara Anda bekerja, bukan sebaliknya:

- Mode Kode: pengkodean sehari-hari, pengeditan, dan operasi file
- Mode Arsitek: merencanakan sistem, spesifikasi, dan migrasi
- Mode Tanya: jawaban cepat, penjelasan, dan dokumen
- Mode Debug: melacak masalah, menambahkan log, mengisolasi akar penyebab
- Mode Kustom: buat mode khusus untuk tim atau alur kerja Anda

Pelajari lebih lanjut: [Menggunakan Mode](https://docs.zoocode.dev/basic-usage/using-modes) • [Mode Kustom](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Sumber daya

- **[Dokumentasi](https://docs.zoocode.dev):** Panduan resmi untuk menginstal, mengonfigurasi, dan menguasai Zoo Code.
- **[Server Discord](https://discord.gg/VxfP4Vx3gX):** Bergabunglah dengan komunitas untuk bantuan dan diskusi real-time.
- **[Komunitas Reddit](https://www.reddit.com/r/ZooCode):** Bagikan pengalaman Anda dan lihat apa yang sedang dibangun orang lain.
- **[Masalah GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Laporkan bug dan lacak pengembangan.
- **[Permintaan Fitur](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Punya ide? Bagikan dengan para pengembang.

---

## Pengaturan & Pengembangan Lokal

1. **Clone** repo:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Instal dependensi**:

```sh
pnpm install
```

3. **Jalankan ekstensi**:

Ada beberapa cara untuk menjalankan ekstensi Zoo Code:

### Mode Pengembangan (F5)

Untuk pengembangan aktif, gunakan debugging bawaan VSCode:

Tekan `F5` (atau buka **Run** → **Start Debugging**) di VSCode. Ini akan membuka jendela VSCode baru dengan ekstensi Zoo Code berjalan.

- Perubahan pada webview akan segera muncul.
- Perubahan pada ekstensi inti juga akan di-hot reload secara otomatis.

### Instalasi VSIX Otomatis

Untuk membangun dan menginstal ekstensi sebagai paket VSIX langsung ke VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Perintah ini akan:

- Menanyakan perintah editor mana yang akan digunakan (code/cursor/code-insiders) - defaultnya adalah 'code'
- Mencopot pemasangan versi ekstensi yang ada.
- Membangun paket VSIX terbaru.
- Menginstal VSIX yang baru dibangun.
- Meminta Anda untuk me-restart VS Code agar perubahan dapat diterapkan.

Pilihan:

- `-y`: Lewati semua prompt konfirmasi dan gunakan default
- `--editor=<command>`: Tentukan perintah editor (misalnya, `--editor=cursor` atau `--editor=code-insiders`)

### Instalasi VSIX Manual

Jika Anda lebih suka menginstal paket VSIX secara manual:

1.  Pertama, bangun paket VSIX:
    ```sh
    pnpm vsix
    ```
2.  File `.vsix` akan dibuat di direktori `bin/` (misalnya, `bin/zoo-code-<version>.vsix`).
3.  Instal secara manual menggunakan VSCode CLI:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Kami menggunakan [changesets](https://github.com/changesets/changesets) untuk pembuatan versi dan publikasi. Periksa `CHANGELOG.md` kami untuk catatan rilis.

---

## Penafian

**Harap dicatat** bahwa Zoo Code **tidak** membuat pernyataan atau jaminan apapun mengenai kode, model, atau alat lain yang disediakan atau tersedia sehubungan dengan Zoo Code, alat pihak ketiga terkait, atau output yang dihasilkan. Anda menanggung **semua risiko** yang terkait dengan penggunaan alat atau output tersebut; alat tersebut disediakan atas dasar **"SEBAGAIMANA ADANYA"** dan **"SEBAGAIMANA TERSEDIA"**. Risiko tersebut dapat mencakup, namun tidak terbatas pada, pelanggaran kekayaan intelektual, kerentanan atau serangan siber, bias, ketidakakuratan, kesalahan, cacat, virus, waktu henti, kehilangan atau kerusakan properti, dan/atau cedera pribadi. Anda sepenuhnya bertanggung jawab atas penggunaan Anda atas alat atau output tersebut (termasuk, namun tidak terbatas pada, legalitas, kesesuaian, dan hasilnya).

---

## Berkontribusi

Kami menyukai kontribusi komunitas! Mulailah dengan membaca [CONTRIBUTING.md](CONTRIBUTING.md) kami.

---

## Lisensi

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Nikmati Zoo Code!** Baik kamu menjaganya tetap dekat atau membiarkannya berkeliaran secara otonom, kami tidak sabar melihat apa yang kamu bangun. Jika kamu punya pertanyaan atau ide fitur, buka sebuah [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) atau mulai sebuah [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Selamat ngoding!
