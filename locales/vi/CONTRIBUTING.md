<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • <b>Tiếng Việt</b> • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Đóng góp cho Zoo Code

Zoo Code là một dự án do cộng đồng điều khiển và chúng tôi vô cùng trân trọng mọi đóng góp. Để hợp lý hóa việc cộng tác, chúng tôi hoạt động trên cơ sở [Ưu tiên vấn đề](#cách-tiếp-cận-ưu-tiên-vấn-đề), có nghĩa là tất cả các [Yêu cầu kéo (PR)](#gửi-yêu-cầu-kéo) trước tiên phải được liên kết với một Vấn đề trên GitHub. Vui lòng xem kỹ hướng dẫn này.

## Bảng mục lục

- [Trước khi bạn đóng góp](#trước-khi-bạn-đóng-góp)
- [Tìm kiếm và lập kế hoạch đóng góp của bạn](#tìm-kiếm-và-lập-kế-hoạch-đóng-góp-của-bạn)
- [Quy trình phát triển và gửi](#quy-trình-phát-triển-và-gửi)
- [Kỳ vọng về Yêu cầu kéo](#kỳ-vọng-về-yêu-cầu-kéo)
- [Đóng góp có sự hỗ trợ của AI](#đóng-góp-có-sự-hỗ-trợ-của-ai)
- [Pháp lý](#pháp-lý)

## Trước khi bạn đóng góp

### 1. Quy tắc ứng xử

Tất cả những người đóng góp phải tuân thủ [Quy tắc ứng xử](./CODE_OF_CONDUCT.md) của chúng tôi.

### 2. Lộ trình dự án

Lộ trình của chúng tôi hướng dẫn định hướng của dự án. Hãy điều chỉnh những đóng góp của bạn với những mục tiêu chính này:

### Ưu tiên độ tin cậy

- Đảm bảo việc chỉnh sửa diff và thực thi lệnh luôn đáng tin cậy.
- Giảm các điểm ma sát ngăn cản việc sử dụng thường xuyên.
- Đảm bảo hoạt động trơn tru trên tất cả các ngôn ngữ và nền tảng.
- Mở rộng hỗ trợ mạnh mẽ cho nhiều nhà cung cấp và mô hình AI.

### Trải nghiệm người dùng nâng cao

- Hợp lý hóa giao diện người dùng/trải nghiệm người dùng để rõ ràng và trực quan.
- Liên tục cải thiện quy trình làm việc để đáp ứng những kỳ vọng cao của các nhà phát triển đối với các công cụ sử dụng hàng ngày.

### Dẫn đầu về hiệu suất tác nhân

- Thiết lập các tiêu chuẩn đánh giá toàn diện (evals) để đo lường năng suất trong thế giới thực.
- Giúp mọi người dễ dàng chạy và diễn giải các đánh giá này.
- Cung cấp các cải tiến cho thấy sự gia tăng rõ ràng về điểm số đánh giá.

Hãy đề cập đến sự phù hợp với các lĩnh vực này trong PR của bạn.

### 3. Tham gia cộng đồng Zoo Code

- **Discord:** Tham gia [Discord](https://discord.gg/VxfP4Vx3gX) của chúng tôi.
- **Reddit:** Tham gia [Reddit](https://www.reddit.com/r/ZooCode/) của chúng tôi.

## Tìm kiếm và lập kế hoạch đóng góp của bạn

### Các loại đóng góp

- **Sửa lỗi:** giải quyết các vấn đề về mã.
- **Tính năng mới:** thêm chức năng.
- **Tài liệu:** cải thiện hướng dẫn và sự rõ ràng.

### Cách tiếp cận Ưu tiên vấn đề

Tất cả các đóng góp đều bắt đầu bằng một Vấn đề trên GitHub bằng cách sử dụng các mẫu gọn nhẹ của chúng tôi.

- **Kiểm tra các vấn đề hiện có**: Tìm kiếm trong [Vấn đề trên GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Tạo một vấn đề** bằng cách sử dụng:
    - **Cải tiến:** mẫu "Yêu cầu cải tiến" (ngôn ngữ đơn giản tập trung vào lợi ích của người dùng).
    - **Lỗi:** mẫu "Báo cáo lỗi" (tái tạo tối thiểu + mong đợi so với thực tế + phiên bản).
- **Bạn muốn làm việc với nó?** Bình luận "Nhận" trên vấn đề và nhắn tin trực tiếp cho nhóm cốt lõi trên [Discord](https://discord.gg/VxfP4Vx3gX) để được giao. Việc giao nhiệm vụ sẽ được xác nhận trong chuỗi.
- **PR phải liên kết đến vấn đề.** Các PR không được liên kết có thể bị đóng.

### Quyết định nên làm gì

- Hãy xem [trang GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues) để tìm issues.
- Để biết tài liệu, hãy truy cập [Tài liệu Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Báo cáo lỗi

- Trước tiên hãy kiểm tra các báo cáo hiện có.
- Tạo một lỗi mới bằng cách sử dụng [mẫu "Báo cáo lỗi"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) với:
    - Các bước tái tạo rõ ràng, được đánh số
    - Kết quả mong đợi so với thực tế
    - Phiên bản Zoo Code (bắt buộc); nhà cung cấp/mô hình API nếu có liên quan
- **Vấn đề bảo mật**: Báo cáo riêng tư qua [tư vấn bảo mật](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Quy trình phát triển và gửi

### Thiết lập phát triển

1. **Rẽ nhánh & Sao chép:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Cài đặt các phụ thuộc:**

```
pnpm install
```

3. **Gỡ lỗi:** Mở bằng VS Code (`F5`).

### Hướng dẫn viết mã

- Một PR tập trung cho mỗi tính năng hoặc bản sửa lỗi.
- Tuân thủ các phương pháp hay nhất của ESLint và TypeScript.
- Viết các cam kết rõ ràng, mô tả có tham chiếu đến các vấn đề (ví dụ: `Sửa lỗi #123`).
- Cung cấp thử nghiệm kỹ lưỡng (`npm test`).
- Rebase lên nhánh `main` mới nhất trước khi gửi.

### Gửi yêu cầu kéo

- Bắt đầu với tư cách là **PR nháp** nếu bạn đang tìm kiếm phản hồi sớm.
- Mô tả rõ ràng những thay đổi của bạn theo Mẫu yêu cầu kéo.
- Liên kết vấn đề trong mô tả/tiêu đề PR (ví dụ: "Sửa lỗi #123").
- Cung cấp ảnh chụp màn hình/video cho các thay đổi giao diện người dùng.
- Cho biết nếu cần cập nhật tài liệu.

### Chính sách yêu cầu kéo

- Phải tham chiếu đến một Vấn đề GitHub đã được giao. Để được giao: bình luận "Nhận" trên vấn đề và nhắn tin trực tiếp cho nhóm cốt lõi trên [Discord](https://discord.gg/VxfP4Vx3gX). Việc giao nhiệm vụ sẽ được xác nhận trong chuỗi.
- Các PR không được liên kết có thể bị đóng.
- Các PR phải vượt qua các bài kiểm tra CI, phù hợp với lộ trình và có tài liệu rõ ràng.

### Quy trình xem xét

- **Phân loại hàng ngày:** kiểm tra nhanh bởi những người bảo trì.
- **Xem xét sâu hàng tuần:** đánh giá toàn diện.
- **Lặp lại nhanh chóng** dựa trên phản hồi.

### Kỳ vọng về Yêu cầu kéo

Các Yêu cầu kéo phải có thể xem xét được, đã được kiểm tra và có thể bảo trì. Trước khi mở PR, hãy đảm bảo rằng:

- Thay đổi được giới hạn trong một vấn đề, lỗi hoặc cải tiến cụ thể.
- Bạn có thể giải thích thay đổi làm gì và tại sao nó đúng.
- Bạn đã kiểm tra thay đổi cục bộ khi có thể thực hiện được.
- Bạn sẵn sàng phản hồi phản hồi xem xét và thực hiện các thay đổi tiếp theo hợp lý.
- PR không yêu cầu những người bảo trì viết lại, thiết kế lại hoặc tiếp quản đáng kể việc triển khai trước khi có thể hợp nhất.

Những người bảo trì có thể đóng các PR không đầy đủ, quá rộng, không hoạt động, không phù hợp với hướng dự án hoặc tạo ra gánh nặng xem xét hoặc bảo trì không tương xứng. Đóng PR không phải là phán xét về người đóng góp; đó là quyết định của người bảo trì rằng thay đổi không thể được chấp nhận ở dạng hiện tại.

### Đóng góp có sự hỗ trợ của AI

Việc sử dụng các công cụ AI được phép, nhưng người đóng góp vẫn hoàn toàn chịu trách nhiệm về các bài nộp của họ.

Nếu bạn sử dụng các công cụ AI để giúp tạo PR, bạn phải:

- Xem xét và hiểu mọi thay đổi có ý nghĩa.
- Có thể giải thích việc triển khai và sự đánh đổi bằng lời của chính bạn.
- Tự kiểm tra thay đổi. Nếu kiểm tra không thực tế trong môi trường của bạn, hãy giải thích lý do trong mô tả PR và mô tả cách người xem xét có thể xác minh thay đổi.
- Xác minh rằng mã được tạo là chính xác, cần thiết và tương thích với giấy phép dự án.
- Cân nhắc tiết lộ sự hỗ trợ AI trong mô tả PR khi nó đã định hình đáng kể mã, kiểm tra hoặc thiết kế — điều này giúp người xem xét đưa ra phản hồi tốt hơn.

Vui lòng không gửi các thay đổi do AI tạo ra mà bạn không hiểu hoặc không thể duy trì trong quá trình xem xét. Những người bảo trì có thể đóng các PR có vẻ được hỗ trợ đáng kể bởi AI nhưng thiếu xác minh của con người, lý do rõ ràng hoặc theo dõi xem xét.

## Pháp lý

Bằng cách đóng góp, bạn đồng ý rằng những đóng góp của bạn sẽ được cấp phép theo Giấy phép Apache 2.0, phù hợp với việc cấp phép của Zoo Code.
