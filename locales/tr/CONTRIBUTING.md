<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • <b>Türkçe</b> • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Zoo Code'a katkıda bulunma

Zoo Code bir topluluk projesidir. Her katkıya değer veriyoruz. [Önce Issue](#issue-first-approach) yaklaşımıyla çalışıyoruz. Her [Pull Request (PR)](#submitting-a-pull-request) bir GitHub Issue'ya bağlantı vermelidir. Bu rehberi dikkatle oku.

<a id="table-of-contents"></a>

## İçindekiler

- [Katkıda bulunmadan önce](#before-you-contribute)
- [Katkını bulma ve planlama](#finding--planning-your-contribution)
- [Geliştirme ve gönderme süreci](#development--submission-process)
    - [Pull Request beklentileri](#pull-request-expectations)
    - [Yapay zekâ destekli katkılar](#ai-assisted-contributions)
    - [Yazım tarzı](#writing-style)
- [Yasal koşullar](#legal)

<a id="before-you-contribute"></a>

## Katkıda bulunmadan önce

<a id="1-code-of-conduct"></a>

### 1. Davranış kuralları

Tüm katkıda bulunanlar [Davranış Kurallarımıza](./CODE_OF_CONDUCT.md) uymalıdır.

<a id="2-project-roadmap"></a>

### 2. Projenin yol haritası

Yol haritamız projenin yönünü gösterir. Katkılarını bu hedeflerle uyumlu tut:

<a id="reliability-first"></a>

### Önce güvenilirlik

- diff düzenlemesinin ve komut çalıştırmanın her seferinde güvenilir olmasını sağla.
- İnsanların Zoo Code'u her gün kullanmasını engelleyen sorunları gider.
- Zoo Code'un tüm dil ve bölge ayarlarında ve platformlarda çalışmasını sağla.
- Daha fazla yapay zekâ sağlayıcısını ve modelini destekle.

<a id="enhanced-user-experience"></a>

### Daha iyi kullanıcı deneyimi

- UI ve UX'i açık ve kolay kullanılır hâle getir.
- İş akışını iyileştir. Geliştiriciler her gün kullandıkları araçlardan yüksek kalite bekler.

<a id="leading-on-agent-performance"></a>

### Ajan performansında öncülük

- Gerçek dünyadaki üretkenliği ölçen değerlendirme testleri (evals) oluştur.
- evals testlerini çalıştırmayı ve okumayı kolaylaştır.
- evals puanlarını belirgin biçimde artıran iyileştirmeler yayınla.

PR'larında değişikliğin bu alanlardan hangilerini desteklediğini belirt.

<a id="3-join-the-zoo-code-community"></a>

### 3. Zoo Code topluluğuna katıl

- **Discord:** [Discord](https://discord.gg/VxfP4Vx3gX) topluluğumuza katıl.
- **Reddit:** [Reddit](https://www.reddit.com/r/ZooCode/) topluluğumuza katıl.

<a id="finding--planning-your-contribution"></a>

## Katkını bulma ve planlama

<a id="types-of-contributions"></a>

### Katkı türleri

- **Hata düzeltmeleri:** Koddaki sorunları düzelt.
- **Yeni özellikler:** İşlevler ekle.
- **Belgeler:** Rehberleri iyileştir ve daha anlaşılır hâle getir.

<a id="issue-first-approach"></a>

### Önce Issue yaklaşımı

Her katkı bir GitHub Issue ile başlar. Kısa şablonlarımızı kullan.

- **Mevcut Issue'ları kontrol et:** [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues) içinde ara.
- **Bir Issue oluştur** ve şu şablonları kullan:
    - **İyileştirmeler:** "Enhancement Request" şablonu (kullanıcıya sağlanan faydaya odaklanan sade dil).
    - **Hatalar:** "Bug Report" şablonu (en küçük yeniden üretme örneği, beklenen ve gerçek sonuç, sürüm).
- **Issue'yu yazarken** aşağıdaki [Yazım Tarzını](#writing-style) kullan.
- **Üzerinde çalışmak mı istiyorsun?** Issue'ya "Claiming" yorumunu ekle. Sonra görevin sana atanması için [Discord](https://discord.gg/VxfP4Vx3gX) üzerinden çekirdek ekiple iletişime geç. Çekirdek ekip atamayı tartışmada doğrular.
- **PR'lar Issue'ya bağlantı vermelidir.** Bağlantısı olmayan PR'ları kapatabiliriz.

<a id="deciding-what-to-work-on"></a>

### Ne üzerinde çalışacağına karar verme

- [GitHub Issues sayfasına](https://github.com/Zoo-Code-Org/Zoo-Code/issues) bak.
- Belgeler için [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs) sayfasına git.

<a id="reporting-bugs"></a>

### Hata bildirme

- Önce mevcut bildirimleri kontrol et.
- ["Bug Report" şablonuyla](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) yeni bir hata bildir ve şunları ekle:
    - Açık, numaralı yeniden üretme adımları
    - Beklenen sonuç ve gerçek sonuç
    - Zoo Code sürümü (zorunlu)
    - İlgiliyse API sağlayıcısı ve model
- **Güvenlik sorunları:** Bunları [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new) ile özel olarak bildir.

<a id="development--submission-process"></a>

## Geliştirme ve gönderme süreci

<a id="development-setup"></a>

### Geliştirme ortamını kurma

1. **Fork oluştur ve klonla:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Bağımlılıkları yükle:**

```
pnpm install
```

3. **Hata ayıklama:** VS Code ile aç (`F5`).

<a id="writing-code-guidelines"></a>

### Kod yazma kuralları

- Her özellik veya düzeltme için tek bir odaklı PR oluştur.
- ESLint ve TypeScript için önerilen uygulamaları izle.
- Issue'lara atıfta bulunan açık ve açıklayıcı commit mesajları yaz (örneğin, `Fixes #123`). [Yazım Tarzını](#writing-style) izle.
- Değişikliğini tamamen test et (`npm test`).
- Göndermeden önce en güncel `main` dalına rebase yap.

<a id="submitting-a-pull-request"></a>

### Pull Request gönderme

- Erken geri bildirim istiyorsan **Draft PR** ile başla.
- Değişikliklerini Pull Request Template ile açıkla. [Yazım Tarzını](#writing-style) izle.
- PR açıklamasında veya başlığında Issue'ya bağlantı ver (örneğin, "Fixes #123").
- UI değişiklikleri için ekran görüntüleri veya videolar ekle.
- Değişikliğin belge güncellemesi gerektirip gerektirmediğini belirt.

<a id="pull-request-policy"></a>

### Pull Request politikası

- PR, bir kişiye atanmış GitHub Issue'ya atıfta bulunmalıdır. Atanmak için Issue'ya "Claiming" yorumunu ekle. Sonra [Discord](https://discord.gg/VxfP4Vx3gX) üzerinden çekirdek ekiple iletişime geç. Çekirdek ekip atamayı tartışmada doğrular.
- Bağlantısı olmayan PR'ları kapatabiliriz.
- PR, CI testlerini geçmeli, yol haritasına uymalı ve açık belgelere sahip olmalıdır.

<a id="review-process"></a>

### İnceleme süreci

İncelemeye hazır bir PR şu koşulları karşılamalıdır:

- Zorunlu CI kontrollerini geçer.
- İşlem gerektiren inceleme geri bildirimlerini ele alır.
- Bir bakım sorumlusundan veya CODEOWNER'dan yeni bir onay alır. Bu onay, son commit için otomatik inceleme tamamlandıktan sonra verilir.

Otomatik inceleme, yol gösteren bir yorum ve yönetilen durum etiketleri ekleyebilir. Yorumdaki sonraki adımı izle. Etiketleri kendin değiştirme. Yeni commit'ler, değişen kodun inceleme durumunu sıfırlar.

`community-approved` etiketi, son commit için yeni bir topluluk onayını gösterir. PR daha sonra bakım sorumlusunun incelemesini bekler. Etiket, bakım sorumlularına öncelik konusunda yol gösterir. Bakım sorumlusunun incelemesinin veya zorunlu bir kontrolün yerini almaz. Etiketi inceleme iş akışı yönetir.

Otomatik inceleme bakım sorumlularına yardım eder. İnsan onayının yerini almaz. Dış katkıcılar yorumlarla CodeRabbit'i yönlendiremez. Uygun bir inceleme, zorunlu CI geçtikten sonra kendiliğinden yeniden başlar. İstisnai yeniden başlatmaları bakım sorumluları yönetir. Depo politikası aksini belirtmedikçe uyarılar tavsiye niteliğindedir. GitHub'ın yerleşik zorunlu kontrolleri, CODEOWNER kuralları ve inceleme korumaları, PR'ın birleştirilip birleştirilemeyeceğini belirler.

- **Günlük değerlendirme:** Bakım sorumluları hızlı kontroller yapar.
- **Haftalık ayrıntılı inceleme:** Bakım sorumluları kapsamlı bir değerlendirme yapar.
- Geri bildirim aldığında **hızla düzeltmeler yap**.

<a id="pull-request-expectations"></a>

### Pull Request beklentileri

PR kolay incelenebilir, test edilmiş ve kolay sürdürülebilir olmalıdır. PR açmadan önce şu noktaları kontrol et:

- Değişiklik tek bir belirli Issue'yu, hatayı veya iyileştirmeyi ele alır.
- Değişikliğin ne yaptığını ve neden doğru olduğunu açıklayabilirsin.
- Mümkün olduğunda değişikliği bilgisayarında test ettin.
- İnceleme geri bildirimlerine yanıt verecek ve makul devam değişikliklerini yapacaksın.
- Birleştirmeden önce bakım sorumlularının değişikliği yeniden yazması, yeniden tasarlaması veya sorumluluğunu üstlenmesi gerekmez.

Bakım sorumluları şu nedenlerle PR'ı kapatabilir:

- Eksiktir.
- Kapsamı çok geniştir.
- Etkin değildir.
- Projenin yönünü izlemez.
- Çok fazla inceleme veya bakım işi oluşturur.

PR'ın kapanması katkıcı hakkında bir yargı değildir. Bakım sorumlularının değişikliği mevcut hâliyle kabul edemediği anlamına gelir.

Bir bot da PR'ları otomatik olarak kapatır:

- **60 gün hareketsizlik:** Bot, 60 gün etkinlik olmazsa PR'ı eski olarak işaretler. Sonraki 7 gün de etkinlik olmazsa PR'ı kapatır. Yeni bir yorum, commit veya inceleme sayacı sıfırlar.
- **Yazarın 14 gün hareketsiz kalması:** İnceleyen kişi değişiklik istediğinde bot `awaiting-author` etiketini ekler. Yazarın etkinliği hareketsizlik sayacını sıfırlar. Değişiklikler hazır olduğunda inceleyen kişiden yeni bir inceleme iste.

PR'ın otomatik kapanmasını durdurmak için `do-not-close`, `pinned` veya `work-in-progress` etiketini ekle.

<a id="ai-assisted-contributions"></a>

### Yapay zekâ destekli katkılar

Yapay zekâ araçlarını kullanabilirsin. Gönderdiğin katkının tüm sorumluluğu yine sana aittir.

PR oluştururken yapay zekâ araçlarından yardım alırsan şunları yapmalısın:

- Her önemli değişikliği incele ve anla.
- Uygulamayı ve yapılan tercihlerin artı ve eksilerini kendi sözlerinle açıkla.
- Değişikliği kendin test et. Kendi ortamında test edemiyorsan PR açıklamasında nedenini belirt. İnceleyenlerin değişikliği nasıl doğrulayabileceğini de açıkla.
- Üretilen kodun doğru, gerekli ve proje lisansıyla uyumlu olduğunu kontrol et.
- PR açıklamasında yapay zekâ yardımını belirtmeyi düşün. Yapay zekâ yardımı kodu, testleri veya tasarımı büyük ölçüde değiştirdiyse bunu belirt. Bu, inceleyenlerin daha iyi geri bildirim vermesini sağlar.

Anlamadığın yapay zekâ üretimi değişiklikleri gönderme. İnceleme boyunca sürdüremeyeceğin değişiklikleri gönderme. Bakım sorumluları, büyük ölçüde yapay zekâ yardımı almış görünen bir PR'ı kapatabilir. İnsan doğrulaması, açık bir gerekçe veya inceleme takibi yoksa bunu yapabilirler.

<a id="writing-style"></a>

### Yazım tarzı

Bu kurallar yalnızca İngilizce metinlere uygulanır. Issue başlıklarını ve metinlerini, PR başlıklarını ve açıklamalarını ve commit mesajlarını [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/) ile yaz. Issue ve PR şablonları aynı hatırlatmayı içerir.

- Kısa cümleler kullan. Bir talimatta en fazla 20 kelime kullan.
- Sade kelimeler kullan. "utilize" yerine "use" yaz. "commence" yerine "start" yaz.
- Etken çatı kullan. "the file is read by the parser" yerine "the parser reads the file" yaz.
- Her cümlede tek bir fikir anlat.
- Kısaltılmış sözcük biçimleri, noktalı virgül veya uzun tire kullanma.
- Başlığı kısa ve belirli tut.
- Tam günlük kayıtlarını, hata mesajlarını, tanımlayıcıları, komutları veya yeniden üretme kanıtlarını değiştirme. Oldukları gibi yapıştır.

Bu kurallar yazım rehberidir. İnceleyenler resmî ASD-STE100 uyumunu kontrol etmez. Kod, tanımlayıcılar ve komut sözdizimi bu kuralın kapsamı dışındadır.

<a id="legal"></a>

## Yasal koşullar

Katkıda bulunduğunda katkılarının Apache 2.0 Lisansı kapsamında olmasını kabul edersin. Bu, Zoo Code'un lisansıdır.
