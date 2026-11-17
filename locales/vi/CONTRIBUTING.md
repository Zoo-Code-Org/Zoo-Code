<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • <b>Tiếng Việt</b> • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Đóng góp cho Zoo Code

Zoo Code là dự án cộng đồng. Chúng mình trân trọng mọi đóng góp. Chúng mình làm việc theo cách [tạo Issue trước](#issue-first-approach). Mỗi [Pull Request (PR)](#submitting-a-pull-request) phải liên kết đến một GitHub Issue. Hãy đọc kỹ hướng dẫn này.

<a id="table-of-contents"></a>

## Mục lục

- [Trước khi đóng góp](#before-you-contribute)
- [Tìm và lên kế hoạch đóng góp](#finding--planning-your-contribution)
- [Quy trình phát triển và gửi thay đổi](#development--submission-process)
    - [Yêu cầu đối với Pull Request](#pull-request-expectations)
    - [Đóng góp có AI hỗ trợ](#ai-assisted-contributions)
    - [Cách viết](#writing-style)
- [Điều kiện pháp lý](#legal)

<a id="before-you-contribute"></a>

## Trước khi đóng góp

<a id="1-code-of-conduct"></a>

### 1. Quy tắc ứng xử

Mọi người đóng góp phải tuân theo [Quy tắc ứng xử](./CODE_OF_CONDUCT.md) của chúng mình.

<a id="2-project-roadmap"></a>

### 2. Lộ trình dự án

Lộ trình cho biết hướng phát triển của dự án. Hãy điều chỉnh đóng góp của bạn theo các mục tiêu này:

<a id="reliability-first"></a>

### Ưu tiên độ tin cậy

- Đảm bảo chỉnh sửa bằng diff và chạy lệnh hoạt động tin cậy mỗi lần.
- Loại bỏ các vấn đề khiến mọi người không thể dùng Zoo Code hằng ngày.
- Giúp Zoo Code hoạt động với mọi ngôn ngữ, khu vực và nền tảng.
- Hỗ trợ thêm các nhà cung cấp AI và mô hình.

<a id="enhanced-user-experience"></a>

### Cải thiện trải nghiệm người dùng

- Làm cho UI và UX rõ ràng, dễ dùng.
- Cải thiện quy trình làm việc. Lập trình viên kỳ vọng chất lượng cao ở những công cụ họ dùng hằng ngày.

<a id="leading-on-agent-performance"></a>

### Dẫn đầu về hiệu suất tác tử

- Xây dựng các bài đánh giá (evals) đo năng suất trong thực tế.
- Giúp evals dễ chạy và dễ đọc.
- Phát hành những cải tiến làm tăng rõ rệt điểm evals.

Trong PR, hãy nêu thay đổi hỗ trợ những lĩnh vực nào ở trên.

<a id="3-join-the-zoo-code-community"></a>

### 3. Tham gia cộng đồng Zoo Code

- **Discord:** Tham gia [Discord](https://discord.gg/VxfP4Vx3gX) của chúng mình.
- **Reddit:** Tham gia [Reddit](https://www.reddit.com/r/ZooCode/) của chúng mình.

<a id="finding--planning-your-contribution"></a>

## Tìm và lên kế hoạch đóng góp

<a id="types-of-contributions"></a>

### Các loại đóng góp

- **Sửa lỗi:** Sửa các vấn đề trong mã.
- **Tính năng mới:** Thêm chức năng.
- **Tài liệu:** Cải thiện hướng dẫn và làm cho chúng rõ ràng hơn.

<a id="issue-first-approach"></a>

### Tạo Issue trước

Mỗi đóng góp bắt đầu bằng một GitHub Issue. Hãy dùng các mẫu ngắn của chúng mình.

- **Kiểm tra Issue hiện có:** Tìm trong [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Tạo Issue** bằng:
    - **Cải tiến:** Mẫu "Enhancement Request" (ngôn ngữ đơn giản, tập trung vào lợi ích cho người dùng).
    - **Lỗi:** Mẫu "Bug Report" (ví dụ tái hiện tối thiểu, kết quả mong đợi và thực tế, phiên bản).
- **Viết Issue** theo phần [Cách viết](#writing-style) bên dưới.
- **Bạn muốn làm việc này?** Bình luận "Claiming" trong Issue. Sau đó liên hệ nhóm nòng cốt trên [Discord](https://discord.gg/VxfP4Vx3gX) để được giao việc. Nhóm nòng cốt xác nhận việc giao trong luồng thảo luận.
- **PR phải liên kết đến Issue.** Chúng mình có thể đóng PR không có liên kết.

<a id="deciding-what-to-work-on"></a>

### Chọn việc để làm

- Xem [trang GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Với tài liệu, hãy đến [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Báo lỗi

- Trước tiên, kiểm tra các báo cáo hiện có.
- Tạo báo cáo lỗi mới bằng [mẫu "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) và thêm:
    - Các bước tái hiện rõ ràng, có đánh số
    - Kết quả mong đợi và kết quả thực tế
    - Phiên bản Zoo Code (bắt buộc)
    - Nhà cung cấp API và mô hình, nếu có liên quan
- **Vấn đề bảo mật:** Báo riêng qua [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Quy trình phát triển và gửi thay đổi

<a id="development-setup"></a>

### Thiết lập môi trường phát triển

1. **Tạo fork và clone:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Cài các gói phụ thuộc:**

```
pnpm install
```

3. **Gỡ lỗi:** Mở bằng VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Hướng dẫn viết mã

- Mỗi tính năng hoặc bản sửa lỗi chỉ có một PR tập trung vào việc đó.
- Làm theo các cách dùng tốt nhất của ESLint và TypeScript.
- Viết thông điệp commit rõ ràng, có mô tả và tham chiếu đến Issue (ví dụ, `Fixes #123`). Làm theo phần [Cách viết](#writing-style).
- Kiểm thử đầy đủ thay đổi của bạn (`npm test`).
- Rebase lên nhánh `main` mới nhất trước khi gửi.

<a id="submitting-a-pull-request"></a>

### Gửi Pull Request

- Bắt đầu với **Draft PR** nếu bạn muốn nhận góp ý sớm.
- Mô tả thay đổi bằng Pull Request Template. Làm theo phần [Cách viết](#writing-style).
- Liên kết Issue trong mô tả hoặc tiêu đề PR (ví dụ, "Fixes #123").
- Thêm ảnh chụp màn hình hoặc video cho thay đổi UI.
- Nêu rõ thay đổi có cần cập nhật tài liệu không.

<a id="pull-request-policy"></a>

### Chính sách Pull Request

- PR phải tham chiếu đến một GitHub Issue đã được giao. Để được giao, hãy bình luận "Claiming" trong Issue. Sau đó liên hệ nhóm nòng cốt trên [Discord](https://discord.gg/VxfP4Vx3gX). Nhóm nòng cốt xác nhận việc giao trong luồng thảo luận.
- Chúng mình có thể đóng PR không có liên kết.
- PR phải vượt qua kiểm thử CI, theo đúng lộ trình và có tài liệu rõ ràng.

<a id="review-process"></a>

### Quy trình đánh giá

PR sẵn sàng để đánh giá phải đáp ứng các điều kiện sau:

- Vượt qua các kiểm tra CI bắt buộc.
- Xử lý những góp ý đánh giá cần hành động.
- Nhận chấp thuận mới từ người bảo trì hoặc CODEOWNER. Việc này diễn ra sau khi đánh giá tự động hoàn tất cho commit mới nhất.

Đánh giá tự động có thể thêm bình luận hướng dẫn và nhãn trạng thái do hệ thống quản lý. Hãy làm theo bước tiếp theo trong bình luận. Đừng tự sửa các nhãn. Commit mới đặt lại trạng thái đánh giá của mã đã thay đổi.

Nhãn `community-approved` cho biết commit mới nhất đã nhận chấp thuận mới từ cộng đồng. Sau đó PR chờ người bảo trì đánh giá. Nhãn giúp người bảo trì cân nhắc mức ưu tiên. Nhãn không thay thế đánh giá của người bảo trì hay kiểm tra bắt buộc. Quy trình đánh giá quản lý nhãn này.

Đánh giá tự động giúp người bảo trì. Nó không thay thế chấp thuận của con người. Người đóng góp bên ngoài không thể điều khiển CodeRabbit bằng bình luận. Đánh giá đủ điều kiện tự chạy lại sau khi CI bắt buộc thành công. Người bảo trì xử lý các lần chạy lại ngoại lệ. Cảnh báo chỉ mang tính hướng dẫn, trừ khi chính sách kho mã quy định khác. Các kiểm tra bắt buộc có sẵn của GitHub, quy tắc CODEOWNER và biện pháp bảo vệ đánh giá quyết định PR có thể được hợp nhất không.

- **Sàng lọc hằng ngày:** Người bảo trì kiểm tra nhanh.
- **Đánh giá sâu hằng tuần:** Người bảo trì đánh giá đầy đủ.
- **Nhanh chóng chỉnh sửa** khi nhận góp ý.

<a id="pull-request-expectations"></a>

### Yêu cầu đối với Pull Request

PR phải dễ đánh giá, đã được kiểm thử và dễ bảo trì. Trước khi mở PR, hãy kiểm tra các điểm sau:

- Thay đổi giải quyết một Issue, lỗi hoặc cải tiến cụ thể.
- Bạn có thể giải thích thay đổi làm gì và vì sao nó đúng.
- Bạn đã kiểm thử thay đổi trên máy của mình khi có thể.
- Bạn sẽ trả lời góp ý đánh giá và thực hiện những thay đổi tiếp theo hợp lý.
- Người bảo trì không cần viết lại, thiết kế lại hoặc tiếp quản thay đổi trước khi hợp nhất.

Người bảo trì có thể đóng PR vì các lý do sau:

- PR chưa hoàn chỉnh.
- Phạm vi quá rộng.
- Không có hoạt động.
- Không theo hướng phát triển của dự án.
- Tạo ra quá nhiều việc đánh giá hoặc bảo trì.

Đóng PR không phải là đánh giá người đóng góp. Điều đó có nghĩa là người bảo trì không thể nhận thay đổi ở dạng hiện tại.

Bot cũng tự động đóng PR:

- **60 ngày không hoạt động:** Bot đánh dấu PR là cũ sau 60 ngày không có hoạt động. Nếu vẫn không có hoạt động sau 7 ngày nữa, bot đóng PR. Bình luận, commit hoặc đánh giá mới đặt lại bộ đếm.
- **Tác giả không hoạt động trong 14 ngày:** Khi người đánh giá yêu cầu thay đổi, bot thêm nhãn `awaiting-author`. Hoạt động của tác giả đặt lại bộ đếm không hoạt động. Khi thay đổi đã sẵn sàng, hãy yêu cầu người đánh giá đánh giá lại.

Để ngăn PR tự động đóng, hãy thêm nhãn `do-not-close`, `pinned` hoặc `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Đóng góp có AI hỗ trợ

Bạn có thể dùng công cụ AI. Bạn vẫn chịu toàn bộ trách nhiệm về đóng góp đã gửi.

Nếu dùng công cụ AI để hỗ trợ tạo PR, bạn phải:

- Xem xét và hiểu từng thay đổi quan trọng.
- Giải thích cách triển khai và các đánh đổi bằng lời của mình.
- Tự kiểm thử thay đổi. Nếu không thể kiểm thử trong môi trường của mình, hãy giải thích lý do trong mô tả PR. Cũng hãy mô tả cách người đánh giá có thể xác minh thay đổi.
- Kiểm tra mã được tạo là đúng, cần thiết và tương thích với giấy phép dự án.
- Cân nhắc việc nêu hỗ trợ của AI trong mô tả PR. Hãy nêu khi AI làm thay đổi đáng kể mã, kiểm thử hoặc thiết kế. Điều này giúp người đánh giá đưa ra góp ý tốt hơn.

Đừng gửi thay đổi do AI tạo mà bạn không hiểu. Đừng gửi thay đổi mà bạn không thể bảo trì trong quá trình đánh giá. Người bảo trì có thể đóng PR có vẻ dùng nhiều hỗ trợ từ AI. Họ có thể làm vậy nếu thiếu xác minh của con người, lý do rõ ràng hoặc theo dõi góp ý đánh giá.

<a id="writing-style"></a>

### Cách viết

Các quy tắc này chỉ áp dụng cho văn bản tiếng Anh. Viết tiêu đề và nội dung Issue, tiêu đề và mô tả PR, cùng thông điệp commit bằng [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Mẫu Issue và PR cũng có lời nhắc này.

- Dùng câu ngắn. Mỗi câu hướng dẫn có tối đa 20 từ.
- Dùng từ đơn giản. Viết "use", không viết "utilize". Viết "start", không viết "commence".
- Dùng thể chủ động. Viết "the parser reads the file", không viết "the file is read by the parser".
- Mỗi câu chỉ nêu một ý.
- Không dùng dạng rút gọn, dấu chấm phẩy hoặc dấu gạch ngang dài.
- Giữ tiêu đề ngắn và cụ thể.
- Không sửa nội dung chính xác của nhật ký, thông báo lỗi, định danh, lệnh hoặc bằng chứng tái hiện. Dán nguyên văn.

Các quy tắc này là hướng dẫn viết. Người đánh giá không kiểm tra việc tuân thủ ASD-STE100 chính thức. Mã, định danh và cú pháp lệnh nằm ngoài quy tắc này.

<a id="legal"></a>

## Điều kiện pháp lý

Khi đóng góp, bạn đồng ý rằng đóng góp của mình dùng Giấy phép Apache 2.0. Đây là giấy phép của Zoo Code.
