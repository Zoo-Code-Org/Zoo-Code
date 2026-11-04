<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • <b>Bahasa Indonesia</b> • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Berkontribusi pada Zoo Code

Zoo Code adalah proyek komunitas. Kami menghargai setiap kontribusi. Kami memakai pendekatan [issue dulu](#issue-first-approach). Artinya, setiap [Pull Request (PR)](#submitting-a-pull-request) harus menautkan issue GitHub. Baca panduan ini dengan teliti.

<a id="table-of-contents"></a>

## Daftar isi

- [Sebelum berkontribusi](#before-you-contribute)
- [Menemukan dan merencanakan kontribusimu](#finding--planning-your-contribution)
- [Proses pengembangan dan pengajuan](#development--submission-process)
    - [Harapan untuk Pull Request](#pull-request-expectations)
    - [Kontribusi dengan bantuan AI](#ai-assisted-contributions)
    - [Gaya penulisan](#writing-style)
- [Ketentuan hukum](#legal)

<a id="before-you-contribute"></a>

## Sebelum berkontribusi

<a id="1-code-of-conduct"></a>

### 1. Kode etik

Semua kontributor harus mengikuti [kode etik](./CODE_OF_CONDUCT.md) kami.

<a id="2-project-roadmap"></a>

### 2. Peta jalan proyek

Peta jalan kami menunjukkan arah proyek. Sesuaikan kontribusimu dengan tujuan ini:

<a id="reliability-first"></a>

### Keandalan lebih dulu

- Buat pengeditan diff dan eksekusi perintah selalu andal.
- Hapus masalah yang menghalangi orang memakai Zoo Code setiap hari.
- Buat Zoo Code bekerja dalam semua bahasa dan di semua platform.
- Tambahkan dukungan untuk lebih banyak penyedia dan model AI.

<a id="enhanced-user-experience"></a>

### Pengalaman pengguna yang lebih baik

- Buat UI dan UX jelas dan mudah dipakai.
- Perbaiki alur kerja. Pengembang mengharapkan standar tinggi dari alat yang mereka pakai setiap hari.

<a id="leading-on-agent-performance"></a>

### Unggul dalam kinerja agen

- Buat tolok ukur evaluasi (evals) yang mengukur produktivitas dalam penggunaan nyata.
- Buat evals mudah dijalankan dan dibaca.
- Rilis perbaikan yang jelas meningkatkan skor evals.

Dalam PR-mu, sebutkan bidang mana yang didukung oleh perubahan itu.

<a id="3-join-the-zoo-code-community"></a>

### 3. Bergabung dengan komunitas Zoo Code

- **Discord:** Bergabung dengan [Discord](https://discord.gg/VxfP4Vx3gX) kami.
- **Reddit:** Bergabung dengan [Reddit](https://www.reddit.com/r/ZooCode/) kami.

<a id="finding--planning-your-contribution"></a>

## Menemukan dan merencanakan kontribusimu

<a id="types-of-contributions"></a>

### Jenis kontribusi

- **Perbaikan bug:** Perbaiki masalah kode.
- **Fitur baru:** Tambahkan fungsi.
- **Dokumentasi:** Perbaiki panduan dan buat lebih jelas.

<a id="issue-first-approach"></a>

### Issue dulu

Setiap kontribusi dimulai dengan issue GitHub. Pakai template singkat kami.

- **Periksa issue yang ada**: Cari di [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Buat issue** dengan:
    - **Peningkatan:** Template "Enhancement Request" (bahasa sederhana yang berfokus pada manfaat bagi pengguna).
    - **Bug:** Template "Bug Report" (reproduksi minimal, hasil yang diharapkan dan hasil sebenarnya, versi).
- **Tulis issue** dengan [gaya penulisan](#writing-style) di bawah ini.
- **Ingin mengerjakannya?** Tulis komentar "Claiming" pada issue. Lalu hubungi tim inti di [Discord](https://discord.gg/VxfP4Vx3gX) untuk mendapat penugasan. Tim inti mengonfirmasi penugasan di utas.
- **PR harus menautkan issue.** Kami bisa menutup PR tanpa tautan itu.

<a id="deciding-what-to-work-on"></a>

### Memilih pekerjaan

- Lihat [halaman GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Untuk dokumentasi, buka [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Melaporkan bug

- Periksa laporan yang ada lebih dulu.
- Buat laporan bug baru dengan [template "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) yang memuat:
    - Langkah reproduksi yang jelas dan bernomor
    - Hasil yang diharapkan dan hasil sebenarnya
    - Versi Zoo Code (wajib)
    - Penyedia API dan model, jika relevan
- **Masalah keamanan**: Laporkan secara pribadi melalui [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Proses pengembangan dan pengajuan

<a id="development-setup"></a>

### Menyiapkan lingkungan pengembangan

1. **Buat fork dan clone:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Instal dependensi:**

```
pnpm install
```

3. **Debugging:** Buka dengan VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Panduan menulis kode

- Satu PR terfokus untuk setiap fitur atau perbaikan.
- Ikuti praktik terbaik ESLint dan TypeScript.
- Tulis commit yang jelas dan deskriptif dengan rujukan ke issue (misalnya, `Fixes #123`). Ikuti [gaya penulisan](#writing-style).
- Uji perubahanmu secara menyeluruh (`npm test`).
- Lakukan rebase ke versi terbaru cabang `main` sebelum mengajukan PR.

<a id="submitting-a-pull-request"></a>

### Mengajukan Pull Request

- Mulai dengan **PR draf** jika kamu ingin masukan lebih awal.
- Jelaskan perubahanmu dengan Pull Request Template. Ikuti [gaya penulisan](#writing-style).
- Tautkan issue di deskripsi atau judul PR (misalnya, "Fixes #123").
- Tambahkan tangkapan layar atau video untuk perubahan UI.
- Sebutkan apakah perubahan itu memerlukan pembaruan dokumentasi.

<a id="pull-request-policy"></a>

### Kebijakan Pull Request

- PR harus merujuk ke issue GitHub yang sudah ditugaskan. Untuk mendapat penugasan, tulis komentar "Claiming" pada issue. Lalu hubungi tim inti di [Discord](https://discord.gg/VxfP4Vx3gX). Tim inti mengonfirmasi penugasan di utas.
- Kami bisa menutup PR tanpa tautan itu.
- PR harus lulus pengujian CI, mengikuti peta jalan, dan memiliki dokumentasi yang jelas.

<a id="review-process"></a>

### Proses peninjauan

PR yang siap ditinjau harus memenuhi syarat ini:

- Lulus pemeriksaan CI yang wajib.
- Menangani masukan peninjauan yang memerlukan tindakan.
- Mendapat persetujuan baru dari pengelola atau CODEOWNER. Ini terjadi setelah peninjauan otomatis untuk commit terbaru selesai.

Peninjauan otomatis bisa menambahkan komentar panduan dan label status yang dikelola alur peninjauan. Ikuti langkah berikutnya dalam komentar. Jangan ubah label sendiri. Commit baru mengatur ulang status peninjauan untuk kode yang berubah.

Label `community-approved` menunjukkan persetujuan baru dari komunitas untuk commit terbaru. PR lalu menunggu peninjauan pengelola. Label ini memberi petunjuk prioritas kepada pengelola. Label ini tidak menggantikan peninjauan pengelola atau pemeriksaan wajib. Alur peninjauan mengelola label ini.

Peninjauan otomatis membantu pengelola. Ini tidak menggantikan persetujuan manusia. Kontributor luar tidak bisa mengarahkan CodeRabbit lewat komentar. Peninjauan yang memenuhi syarat dimulai ulang sendiri setelah CI wajib lulus. Pengelola menangani mulai ulang dalam kasus khusus. Peringatan bersifat saran, kecuali kebijakan repositori menyatakan sebaliknya. Pemeriksaan wajib bawaan GitHub, aturan CODEOWNER, dan perlindungan peninjauan menentukan apakah PR bisa digabungkan.

- **Triase harian:** Pengelola melakukan pemeriksaan singkat.
- **Peninjauan mendalam mingguan:** Pengelola melakukan penilaian lengkap.
- **Segera lakukan penyesuaian** saat mendapat masukan.

<a id="pull-request-expectations"></a>

### Harapan untuk Pull Request

PR harus mudah ditinjau, sudah diuji, dan mudah dipelihara. Sebelum membuka PR, pastikan hal ini:

- Perubahan menangani satu issue, bug, atau peningkatan tertentu.
- Kamu bisa menjelaskan apa yang dilakukan perubahan itu dan mengapa perubahan itu benar.
- Kamu sudah menguji perubahan di komputermu jika memungkinkan.
- Kamu akan menjawab masukan peninjauan dan membuat perubahan lanjutan yang wajar.
- Pengelola tidak perlu menulis ulang, merancang ulang, atau mengambil alih perubahan sebelum PR bisa digabungkan.

Pengelola bisa menutup PR karena alasan ini:

- PR belum lengkap.
- Cakupannya terlalu luas.
- PR tidak aktif.
- PR tidak mengikuti arah proyek.
- PR menambah terlalu banyak pekerjaan peninjauan atau pemeliharaan.

Menutup PR bukan penilaian terhadap kontributornya. Itu berarti pengelola tidak bisa menerima perubahan dalam bentuk saat ini.

Bot juga menutup PR secara otomatis:

- **60 hari tanpa aktivitas:** Bot menandai PR sebagai tidak aktif setelah 60 hari tanpa aktivitas. Jika tetap tidak ada aktivitas selama 7 hari berikutnya, bot menutup PR. Komentar, commit, atau peninjauan baru mengatur ulang penghitung waktu.
- **14 hari tanpa aktivitas penulis:** Saat peninjau meminta perubahan, bot menambahkan label `awaiting-author`. Aktivitas penulis mengatur ulang penghitung waktu tidak aktif. Saat perubahan siap, minta peninjau melakukan peninjauan baru.

Untuk mencegah penutupan otomatis PR, tambahkan label `do-not-close`, `pinned`, atau `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Kontribusi dengan bantuan AI

Kamu boleh memakai alat AI. Kamu tetap bertanggung jawab penuh atas pengajuanmu.

Jika kamu memakai alat AI untuk membantu membuat PR, kamu harus:

- Meninjau dan memahami setiap perubahan penting.
- Menjelaskan implementasi dan komprominya dengan kata-katamu sendiri.
- Menguji perubahan sendiri. Jika kamu tidak bisa menguji di lingkunganmu, jelaskan alasannya dalam deskripsi PR. Jelaskan juga cara peninjau memeriksa perubahan itu.
- Memastikan kode yang dihasilkan benar, diperlukan, dan sesuai dengan lisensi proyek.
- Mempertimbangkan untuk menyebut bantuan AI dalam deskripsi PR. Lakukan ini jika bantuan AI banyak mengubah kode, pengujian, atau desain. Ini membantu peninjau memberi masukan yang lebih baik.

Jangan ajukan perubahan buatan AI yang tidak kamu pahami. Jangan ajukan perubahan yang tidak bisa kamu pelihara selama peninjauan. Pengelola bisa menutup PR yang tampak banyak dibantu AI. Mereka bisa melakukannya jika tidak ada verifikasi manusia, alasan yang jelas, atau tindak lanjut dalam peninjauan.

<a id="writing-style"></a>

### Gaya penulisan

Aturan ini berlaku untuk teks bahasa Inggris. Tulis judul issue, isi issue, judul PR, deskripsi PR, dan pesan commit dalam [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Template issue dan PR memberi pengingat yang sama.

- Pakai kalimat pendek. Pakai 20 kata atau kurang untuk satu instruksi.
- Pakai kata sederhana. Tulis "use", bukan "utilize". Tulis "start", bukan "commence".
- Pakai kalimat aktif. Tulis "the parser reads the file", bukan "the file is read by the parser".
- Tulis satu gagasan dalam setiap kalimat.
- Jangan pakai bentuk kata yang disingkat, titik koma, atau tanda pisah panjang.
- Buat judul singkat dan spesifik.
- Jangan ubah log, pesan kesalahan, pengenal, perintah, atau bukti reproduksi yang persis. Tempelkan apa adanya.

Aturan ini adalah panduan penulisan. Peninjau tidak memeriksa kepatuhan formal terhadap ASD-STE100. Kode, pengenal, dan sintaks perintah tidak termasuk dalam aturan ini.

<a id="legal"></a>

## Ketentuan hukum

Dengan berkontribusi, kamu setuju bahwa kontribusimu memakai Lisensi Apache 2.0. Ini adalah lisensi Zoo Code.
