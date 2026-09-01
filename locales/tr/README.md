<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Hızlıca yardım al → <a href="https://discord.gg/VxfP4Vx3gX">Discord'a katıl</a> • Eşzamansız mı tercih ediyorsun? → <a href="https://www.reddit.com/r/ZooCode/">r/ZooCode'a katıl</a></em>
        </p>

        # Zoo Code

        > AI destekli dev ekibin, doğrudan editörünün içinde

        ## Biz Zoo Code'uz

> Roo ekibi, [Roomote](https://roomote.dev/) üzerine odaklanmak için Roo
> Code'un aktif geliştirmesini durdurduktan sonra Zoo Code bu projenin
> geliştirilmesini sürdürüyor. İnşa ettikleri her şey için Roo ekibine
> teşekkürler.
>
> Çekirdek ekip, daha önce Roo'ya katkıda bulunmuş ve bu eklentiye gerçekten
> önem veren geliştiricilerden oluşuyor. Model güncellemeleri yapmaya,
> hataları düzeltmeye ve özellikler yayınlamaya devam edeceğiz ve bu
> eklentiyi bu kadar özel kılan topluluğu yakından dinlemeyi planlıyoruz.
> Bize katıl:
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), ya da
> [PR veya issue aç](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Roo Code'dan Zoo Code'a geçiş

Roo Code'dan Zoo Code'a geçmek için hızlı bir rehberi [Roo→Zoo geçiş rehberinde](https://docs.zoocode.dev/roo-to-zoo-migration) bulabilirsin. Geçiş sürecinde kullanıcılara elimizden geldiğince yardımcı olmak istiyoruz ve bunun için [Reddit](https://www.reddit.com/r/ZooCode) ile [Discord](https://discord.gg/VxfP4Vx3gX) topluluklarımız var. Bir sorun yaşarsan ya da soruların olursa gel ve sor.

## Zoo Code'un Roo Code'dan Sonra Ekledikleri

Zoo Code, Roo Code'un oluşturduğu temel üzerine inşa ediliyor ve bu temeli şunlarla genişletmeye devam ediyor:

- **Semble kod tabanı zekâsı** — otomatik kurulumla çalışan, ayrı bir indeksleme iş akışı gerektirmeyen hızlı ve isteğe bağlı semantik kod araması.
- **Daha güçlü Orchestrator iş akışları** — daha güvenli görev devri, paralel görev koordinasyonu, güvenilir üst/alt görev kurtarma ve alt görevlerle sağlayıcı profilleri arasında daha iyi yalıtım.
- **Destructive Command Guard (DCG) ile daha uzun otonom çalıştırmalar** — güvenilir işler tekrarlanan onay istekleri olmadan sürerken tehlikeli komutları otomatik olarak engeller.
- **En yeni modeller** — yeni Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax ve diğer model aileleri için sürekli destek.
- **Daha fazla bağlantı seçeneği** — Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go ve çok daha fazlası dahil yeni ve genişletilmiş sağlayıcılar.
- **Daha güvenilir terminal ve düzenleme iş akışları** — terminalin erken tamamlanması, görev durumu yarış koşulları, bağlam yönetimi, diff düzenleme ve sağlayıcıya özel araç kullanımı için düzeltmeler.
- **Çalışma alanın üzerinde daha fazla kontrol** — kural yönetimi, mod başına MCP kısıtlamaları, çok köklü yol denetimleri, model reasoning seçenekleri ve tamamlanan değişiklikleri inceleme eylemleri.

## v3.80.1'daki Yenilikler

🤖 Yeni Zoo Gateway'de bakiyesi olan kullanıcılar GLM-5.3-Flash ve Gemini 3.7 Flash'ı 2 hafta boyunca %50 indirimle, MiniMax M3'ü ise tamamen ÜCRETSİZ deneyebilir. https://zoocode.dev/models

- **Yeni model** — GLM-5.3-Flash artık Z AI üzerinden kullanılabilir.
- **Güvenilirlik düzeltmeleri** — alt görev onayları geri getirildi, Vertex Gemini 3.7 boş araç çıktısı, terminal başlatma hataları ve arka plan servis hataları giderildi, IDE temalarındaki okunabilirlik iyileştirildi.

## Zoo Code SİZİN İçin Ne Yapabilir?

- Doğal dil açıklamalarından kod üretin
- Modlarla Uyum Sağlayın: Kod, Mimar, Sor, Hata Ayıkla ve Özel Modlar
- Mevcut kodu yeniden düzenleyin ve hatalarını ayıklayın
- Dokümantasyon yazın ve güncelleyin
- Kod tabanınızla ilgili soruları yanıtlayın
- Tekrarlayan görevleri otomatikleştirin
- MCP Sunucularını kullanın

## Modlar

Zoo Code, sizin çalışma şeklinize uyum sağlar, tam tersi değil:

- Kod Modu: günlük kodlama, düzenlemeler ve dosya işlemleri
- Mimar Modu: sistemleri, özellikleri ve geçişleri planlayın
- Sor Modu: hızlı cevaplar, açıklamalar ve belgeler
- Hata Ayıklama Modu: sorunları izleyin, günlükler ekleyin, kök nedenleri izole edin
- Özel Modlar: ekibiniz veya iş akışınız için özel modlar oluşturun

Daha fazla: [Modları kullanma](https://docs.zoocode.dev/basic-usage/using-modes) • [Özel modlar](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Kaynaklar

- **[Dokümantasyon](https://docs.zoocode.dev):** Zoo Code'u yükleme, yapılandırma ve ustalaşma konusundaki resmi kılavuz.
- **[Discord Sunucusu](https://discord.gg/VxfP4Vx3gX):** Gerçek zamanlı yardım ve tartışma için topluluğa katılın.
- **[Reddit Topluluğu](https://www.reddit.com/r/ZooCode):** Deneyimlerinizi paylaşın ve başkalarının ne inşa ettiğini görün.
- **[GitHub Sorunları](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Hataları bildirin ve gelişimi takip edin.
- **[Özellik İstekleri](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Bir fikriniz mi var? Geliştiricilerle paylaşın.

---

## Yerel Kurulum ve Geliştirme

1. **Depoyu klonlayın**:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Bağımlılıkları yükleyin**:

```sh
pnpm install
```

3. **Uzantıyı çalıştırın**:

Zoo Code uzantısını çalıştırmanın birkaç yolu vardır:

### Geliştirme Modu (F5)

Aktif geliştirme için VSCode'un yerleşik hata ayıklama özelliğini kullanın:

VSCode'da `F5` tuşuna basın (veya **Çalıştır** → **Hata Ayıklamayı Başlat**'a gidin). Bu, Zoo Code uzantısının çalıştığı yeni bir VSCode penceresi açacaktır.

- Web görünümündeki değişiklikler anında görünecektir.
- Çekirdek uzantıdaki değişiklikler de otomatik olarak sıcak yeniden yüklenecektir.

### Otomatik VSIX Kurulumu

Uzantıyı bir VSIX paketi olarak derlemek ve doğrudan VSCode'a yüklemek için:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Bu komut şunları yapacaktır:

- Hangi düzenleyici komutunun kullanılacağını sorar (code/cursor/code-insiders) - varsayılan 'code'
- Uzantının mevcut herhangi bir sürümünü kaldırır.
- En son VSIX paketini oluşturur.
- Yeni oluşturulan VSIX'i yükler.
- Değişikliklerin etkili olması için VS Code'u yeniden başlatmanızı ister.

Seçenekler:

- `-y`: Tüm onay istemlerini atlayın ve varsayılanları kullanın
- `--editor=<command>`: Düzenleyici komutunu belirtin (ör. `--editor=cursor` veya `--editor=code-insiders`)

### Manuel VSIX Kurulumu

VSIX paketini manuel olarak yüklemeyi tercih ederseniz:

1.  İlk olarak, VSIX paketini oluşturun:
    ```sh
    pnpm vsix
    ```
2.  `bin/` dizininde bir `.vsix` dosyası oluşturulur (ör. `bin/zoo-code-<version>.vsix`).
3.  VSCode CLI kullanarak manuel olarak yükleyin:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Sürüm oluşturma ve yayınlama için [changesets](https://github.com/changesets/changesets) kullanıyoruz. Sürüm notları için `CHANGELOG.md` dosyamıza göz atın.

---

## Sorumluluk Reddi Beyanı

**Lütfen dikkat** Zoo Code, Zoo Code ile bağlantılı olarak sağlanan veya kullanıma sunulan herhangi bir kod, model veya diğer araçlar, ilgili üçüncü taraf araçları veya ortaya çıkan çıktılarla ilgili olarak **hiçbir** beyanda bulunmaz veya garanti vermez. Bu tür araçların veya çıktıların kullanımıyla ilişkili **tüm riskleri** üstlenirsiniz; bu tür araçlar **"OLDUĞU GİBİ"** ve **"MEVCUT OLDUĞU GİBİ"** esasına göre sağlanır. Bu tür riskler, fikri mülkiyet ihlali, siber güvenlik açıkları veya saldırıları, önyargı, yanlışlıklar, hatalar, kusurlar, virüsler, kesintiler, mal kaybı veya hasarı ve/veya kişisel yaralanmaları içerebilir, ancak bunlarla sınırlı değildir. Bu tür araçların veya çıktıların kullanımından (yasallığı, uygunluğu ve sonuçları dahil ancak bunlarla sınırlı olmamak üzere) yalnızca siz sorumlusunuz.

---

## Katkıda Bulunma

Topluluk katkılarını çok seviyoruz! [CONTRIBUTING.md](CONTRIBUTING.md) dosyamızı okuyarak başlayın.

---

## Lisans

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Zoo Code'un keyfini çıkar!** Onu ister kısa tasma ile yakınında tut, ister kendi başına dolaşmasına izin ver, neler inşa edeceğini görmek için sabırsızlanıyoruz. Soruların veya özellik fikirlerin varsa bir [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) aç ya da bir [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions) başlat. Mutlu kodlamalar!
