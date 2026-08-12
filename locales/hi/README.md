<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>जल्दी मदद पाएं → <a href="https://discord.gg/VxfP4Vx3gX">Discord जॉइन करें</a> • Async पसंद है? → <a href="https://www.reddit.com/r/ZooCode/">r/ZooCode जॉइन करें</a></em>
        </p>

        # Zoo Code

        > तुम्हारी AI-संचालित डेवलपमेंट टीम, सीधे तुम्हारे एडिटर में

        ## हम हैं Zoo Code

> Roo टीम के [Roomote](https://roomote.dev/) पर focus करने के लिए Roo Code का
> active development बंद करने के बाद, Zoo Code इस project का development
> आगे बढ़ा रहा है। जो कुछ भी उन्होंने बनाया, उसके लिए Roo टीम का धन्यवाद।
>
> Core team ऐसे developers का समूह है जिन्होंने पहले Roo में योगदान दिया है
> और इस plugin की गहराई से परवाह करते हैं। हम models update करते रहेंगे,
> bugs fix करते रहेंगे और features release करते रहेंगे, और हम उस community
> की बात ध्यान से सुनने की योजना बना रहे हैं जिसने इस plugin को इतना खास
> बनाया। हमारे साथ जुड़ो
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), या
> [PR या issue खोलें](https://github.com/Zoo-Code-Org/Zoo-Code) पर।
>
> _-Zoo Code Team_

## Roo Code से Zoo Code migration

Roo Code से Zoo Code में आने के लिए एक quick guide तुम्हें [Roo→Zoo migration guide](https://docs.zoocode.dev/roo-to-zoo-migration) में मिल जाएगी। We plan to help users as much as possible during the transition, और उसी support के लिए हमारा [Reddit](https://www.reddit.com/r/ZooCode) और [Discord](https://discord.gg/VxfP4Vx3gX) है। अगर तुम्हें कोई problem हो या कोई question हो, आकर पूछो।

## Roo Code के बाद Zoo Code ने क्या जोड़ा है

Zoo Code, Roo Code की बनाई नींव पर आगे बढ़ता है और इसे इन सुविधाओं के साथ लगातार विस्तार देता है:

- **Semble codebase intelligence** — तेज़, on-demand semantic code search, automatic setup के साथ और बिना किसी अलग indexing workflow के।
- **ज़्यादा मज़बूत Orchestrator workflows** — अधिक सुरक्षित delegation, parallel task coordination, parent/child tasks की भरोसेमंद recovery और subtasks व provider profiles के बीच बेहतर isolation।
- **Destructive Command Guard (DCG) के साथ लंबे autonomous runs** — भरोसेमंद काम को बिना बार-बार approval मांगे जारी रखते हुए खतरनाक commands को अपने-आप block करता है।
- **नवीनतम models** — नए Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax और अन्य model families के लिए लगातार support।
- **Connect करने के और तरीके** — Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go और कई अन्य नए व विस्तारित providers।
- **ज़्यादा भरोसेमंद terminal और editing workflows** — terminal के समय से पहले पूरा होने, task-state race conditions, context management, diff editing और provider-specific tool use से जुड़ी समस्याओं के fixes।
- **अपने workspace पर ज़्यादा control** — rules management, हर mode के लिए MCP restrictions, multi-root path controls, model reasoning options और completion changes की review actions।

## v3.76.0 में नया क्या है

- **Destructive Command Guard (DCG) के साथ लंबे और बिना रुकावट वाले tasks चलाओ** — DCG खतरनाक commands को block करता है और Zoo को लगातार approval buttons दबवाए बिना काम करते रहने देता है; managed binary downloads और installation को भी अधिक सुरक्षित बनाया गया है।
- **बेहतर provider controls और reliability** — OpenAI Codex की response speed चुनो, updated DeepSeek configurations इस्तेमाल करो और provider-profile changes व चल रहे tasks के बीच अधिक मज़बूत isolation का लाभ लो।
- **Terminal execution का अहम fix** — Zoo अब अगला step शुरू करने से पहले terminal commands के पूरा होने का इंतज़ार करता है, जिससे overlapping work और model का समय से पहले आगे बढ़ना रुकता है।
- Smarter batching संबंधित tool approvals को एक साथ रखती है और असंबंधित requests को अलग रखती है।
- Failures और concurrent requests के दौरान telemetry delivery और model-cache fetching अब अधिक भरोसेमंद हैं।

## Zoo Code आपके लिए क्या कर सकता है?

- प्राकृतिक भाषा विवरण से कोड उत्पन्न करें
- मोड के साथ अनुकूलन: कोड, आर्किटेक्ट, पूछें, डीबग और कस्टम मोड
- मौजूदा कोड को रीफैक्टर और डीबग करें
- दस्तावेज़ लिखें और अपडेट करें
- अपने कोडबेस के बारे में सवालों के जवाब दें
- दोहराए जाने वाले कार्यों को स्वचालित करें
- एमसीपी सर्वर का उपयोग करें

## मोड

रू कोड आपके काम करने के तरीके के अनुकूल है, न कि इसके विपरीत:

- कोड मोड: रोजमर्रा की कोडिंग, संपादन और फ़ाइल संचालन
- आर्किटेक्ट मोड: सिस्टम, स्पेक्स और माइग्रेशन की योजना बनाएं
- पूछें मोड: त्वरित उत्तर, स्पष्टीकरण और डॉक्स
- डीबग मोड: समस्याओं का पता लगाएं, लॉग जोड़ें, मूल कारणों को अलग करें
- कस्टम मोड: अपनी टीम या वर्कफ़्लो के लिए विशेष मोड बनाएं

और जानो: [मोड्स का इस्तेमाल](https://docs.zoocode.dev/basic-usage/using-modes) • [कस्टम मोड्स](https://docs.zoocode.dev/advanced-usage/custom-modes)

## संसाधन

- **[दस्तावेज़ीकरण](https://docs.zoocode.dev):** Zoo Code को स्थापित करने, कॉन्फ़िगर करने और उसमें महारत हासिल करने के लिए आधिकारिक गाइड।
- **[डिस्कॉर्ड सर्वर](https://discord.gg/VxfP4Vx3gX):** रीयल-टाइम सहायता और चर्चा के लिए समुदाय में शामिल हों।
- **[रेडिट समुदाय](https://www.reddit.com/r/ZooCode):** अपने अनुभव साझा करें और देखें कि दूसरे क्या बना रहे हैं।
- **[गिटहब मुद्दे](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** बग की रिपोर्ट करें और विकास को ट्रैक करें।
- **[सुविधा अनुरोध](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** क्या आपके पास कोई विचार है? इसे डेवलपर्स के साथ साझा करें।

---

## स्थानीय सेटअप और विकास

1. **क्लोन** करें रेपो:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **निर्भरताएँ स्थापित करें**:

```sh
pnpm install
```

3. **एक्सटेंशन चलाएँ**:

रू कोड एक्सटेंशन को चलाने के कई तरीके हैं:

### विकास मोड (F5)

सक्रिय विकास के लिए, वीएसकोड के अंतर्निहित डिबगिंग का उपयोग करें:

वीएसकोड में `F5` दबाएं (या **रन** → **डीबगिंग प्रारंभ करें** पर जाएं)। यह Zoo Code एक्सटेंशन के साथ एक नई वीएसकोड विंडो खोलेगा।

- वेबव्यू में किए गए परिवर्तन तुरंत दिखाई देंगे।
- कोर एक्सटेंशन में किए गए परिवर्तन भी स्वचालित रूप से हॉट रीलोड हो जाएंगे।

### स्वचालित VSIX स्थापना

एक्सटेंशन को सीधे वीएसकोड में VSIX पैकेज के रूप में बनाने और स्थापित करने के लिए:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

यह कमांड करेगा:

- पूछेगा कि कौन सा संपादक कमांड उपयोग करना है (कोड/कर्सर/कोड-इनसाइडर्स) - डिफ़ॉल्ट रूप से 'कोड'
- एक्सटेंशन के किसी भी मौजूदा संस्करण को अनइंस्टॉल करें।
- नवीनतम VSIX पैकेज बनाएं।
- नए बनाए गए VSIX को स्थापित करें।
- परिवर्तनों को प्रभावी करने के लिए आपको वीएस कोड को पुनरारंभ करने के लिए संकेत देगा।

विकल्प:

- `-y`: सभी पुष्टिकरण संकेतों को छोड़ दें और डिफ़ॉल्ट का उपयोग करें
- `--editor=<command>`: संपादक कमांड निर्दिष्ट करें (जैसे, `--editor=cursor` या `--editor=code-insiders`)

### मैनुअल VSIX स्थापना

यदि आप VSIX पैकेज को मैन्युअल रूप से स्थापित करना पसंद करते हैं:

1.  पहले, VSIX पैकेज बनाएं:
    ```sh
    pnpm vsix
    ```
2.  `bin/` डायरेक्टरी में एक `.vsix` फ़ाइल जनरेट होगी (जैसे, `bin/zoo-code-<version>.vsix` )।
3.  इसे वीएसकोड सीएलआई का उपयोग करके मैन्युअल रूप से इंस्टॉल करें:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

हम वर्जनिंग और प्रकाशन के लिए [चेंजसेट्स](https://github.com/changesets/changesets) का उपयोग करते हैं। रिलीज नोट्स के लिए हमारी `CHANGELOG.md` देखें।

---

## अस्वीकरण

**कृपया ध्यान दें** कि रू कोड, इंक किसी भी कोड, मॉडल, या अन्य टूल के संबंध में **कोई** प्रतिनिधित्व या वारंटी **नहीं** देता है, जो रू कोड, किसी भी संबंधित तीसरे पक्ष के टूल, या किसी भी परिणामी आउटपुट के संबंध में प्रदान या उपलब्ध कराया गया है। आप ऐसे किसी भी टूल या आउटपुट के उपयोग से जुड़े **सभी जोखिमों** को मानते हैं; ऐसे टूल **"जैसा है"** और **"जैसा उपलब्ध है"** के आधार पर प्रदान किए जाते हैं। ऐसे जोखिमों में, बिना किसी सीमा के, बौद्धिक संपदा का उल्लंघन, साइबर कमजोरियां या हमले, पूर्वाग्रह, अशुद्धि, त्रुटियां, दोष, वायरस, डाउनटाइम, संपत्ति की हानि या क्षति, और/या व्यक्तिगत चोट शामिल हो सकते हैं। आप ऐसे किसी भी टूल या आउटपुट के अपने उपयोग के लिए पूरी तरह से जिम्मेदार हैं (जिसमें, बिना किसी सीमा के, उनकी वैधता, उपयुक्तता और परिणाम शामिल हैं)।

---

## योगदान

हमें सामुदायिक योगदान पसंद है! हमारी [CONTRIBUTING.md](CONTRIBUTING.md) पढ़कर शुरुआत करें।

---

## लाइसेंस

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Zoo Code का आनंद लें!** चाहे आप इसे short leash पर रखें या इसे autonomously घूमने दें, हम यह देखने के लिए उत्साहित हैं कि आप क्या बनाते हैं। अगर आपके पास questions या feature ideas हैं, तो एक [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) खोलें या एक [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions) शुरू करें। Happy coding!
