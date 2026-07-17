<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://youtube.com/@roocodeyt?feature=shared"><img src="https://img.shields.io/badge/YouTube-FF0000?style=flat&logo=youtube&logoColor=white" alt="YouTube"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Cần trợ giúp nhanh → <a href="https://discord.gg/VxfP4Vx3gX">Tham gia Discord</a> • Thích trao đổi không đồng bộ hơn? → <a href="https://www.reddit.com/r/ZooCode/">Tham gia r/ZooCode</a></em>
        </p>

        # Zoo Code

        > Đội ngũ dev dùng AI của bạn, ngay trong trình chỉnh sửa

        ## Chúng tôi là Zoo Code

> Có thể bạn đã thấy [thông báo gần đây](https://x.com/mattrubens/status/2046636598859559114) từ đội ngũ Roo 🦘🦘🦘. Tóm lại, đội ngũ đang dần giảm việc phát triển Roo Code một cách tích cực để tập trung vào [Roomote](https://roomote.dev/). Tin này thật khó chấp nhận với nhiều người dùng Roo; plugin này có ý nghĩa rất lớn với cộng đồng này.
>
> Chúng tôi muốn cảm ơn toàn bộ đội ngũ Roo vì công sức họ đã dành cho plugin này. Chúng tôi sẽ không nêu tên từng người ở đây, nhưng tất cả chúng ta đều có thể đồng ý rằng họ là những nhà phát triển xuất sắc và, quan trọng không kém, là những con người tuyệt vời. Cảm ơn đội ngũ Roo.
>
> Người dùng Roo đến từ đủ mọi kiểu khác nhau. Có người dùng nó chuyên nghiệp trong công việc hằng ngày, có người dùng nó để nghĩ ra những workflow phức tạp đến khó tin. Có người dùng nó để cải thiện chính Roo, trong khi người khác dùng nó để cải thiện những model mà Roo đang sử dụng (siêu meta). Điều chúng tôi muốn nói là cộng đồng rất đa dạng, và dù một chú kangaroo 🦘🦘🦘 là một loài vật cao quý và nổi bật, chúng tôi cảm thấy một "Zoo" 🐘🦡🦒🦓🦛🦧🦭🦦 với nhiều loài khác nhau phản ánh sự đa dạng đó tốt hơn.
>
> Vì vậy, chúng tôi muốn thông báo rằng **Zoo Code** sẽ tiếp tục phát triển dự án quan trọng này. Đội ngũ nòng cốt gồm những nhà phát triển từng đóng góp cho Roo trước đây và thực sự quan tâm đến plugin này. Chúng tôi sẽ tiếp tục cập nhật model, sửa lỗi và phát hành tính năng. Nhưng trên hết, chúng tôi muốn lắng nghe bạn, cộng đồng đã làm cho plugin này trở nên đặc biệt. Vì vậy, hãy tham gia [Discord](https://discord.gg/VxfP4Vx3gX), [Reddit](https://www.reddit.com/r/ZooCode) của chúng tôi, hoặc [tạo PR hay issue](https://github.com/Zoo-Code-Org/Zoo-Code); nhưng hơn hết, chúng tôi mong bạn tiếp tục gắn bó, kết nối và năng động cùng cộng đồng.
>
> _-Zoo Code Team_

## Chuyển từ Roo Code sang Zoo Code

Bạn có thể xem hướng dẫn nhanh để chuyển từ Roo Code sang Zoo Code trong [hướng dẫn chuyển đổi Roo→Zoo](https://docs.zoocode.dev/roo-to-zoo-migration). Chúng tôi muốn hỗ trợ người dùng nhiều nhất có thể trong quá trình chuyển đổi, và đó chính là lý do chúng tôi có [Reddit](https://www.reddit.com/r/ZooCode) và [Discord](https://discord.gg/VxfP4Vx3gX). Nếu bạn gặp vấn đề hoặc có câu hỏi, cứ vào hỏi nhé.

## Điểm mới trong v3.68.0

- **Nhà cung cấp Friendli với hỗ trợ GLM-5.2** — dùng mẫu GLM mới nhất qua Friendli.
- **Hỗ trợ thinking/reasoning gốc cho Ollama** — giữ đầu ra suy luận xuyên suốt khi bạn dùng các mẫu Ollama.
- **Sửa lỗi `apiModelId` tùy chỉnh của Anthropic** — ID mẫu Anthropic tùy chỉnh giờ sẽ tiếp tục được chọn thay vì âm thầm rơi về `claude-sonnet-4-5`.
- Sửa lỗi: xử lý kết quả công cụ của nhà cung cấp Ollama và cô đọng ngữ cảnh quá sớm.
- Sửa lỗi: giữ liên kết cha-con của tác vụ khi một tác vụ con được ủy quyền bị gián đoạn.
- Cải thiện xử lý khối nội dung Claude trên Anthropic Vertex để có phản hồi đáng tin cậy hơn.
- Cập nhật CI, phát hành nightly và phụ thuộc/công cụ.

## Zoo Code có thể làm gì cho BẠN?

- Tạo mã từ mô tả ngôn ngữ tự nhiên
- Thích ứng với các Chế độ: Mã, Kiến trúc sư, Hỏi, Gỡ lỗi và Chế độ tùy chỉnh
- Tái cấu trúc & gỡ lỗi mã hiện có
- Viết & cập nhật tài liệu
- Trả lời câu hỏi về cơ sở mã của bạn
- Tự động hóa các tác vụ lặp đi lặp lại
- Sử dụng Máy chủ MCP

## Chế độ

Zoo Code thích ứng với cách bạn làm việc, chứ không phải ngược lại:

- Chế độ Mã: viết mã hàng ngày, chỉnh sửa và các thao tác với tệp
- Chế độ Kiến trúc sư: lập kế hoạch hệ thống, thông số kỹ thuật và di chuyển
- Chế độ Hỏi: câu trả lời nhanh, giải thích và tài liệu
- Chế độ Gỡ lỗi: theo dõi sự cố, thêm nhật ký, cô lập nguyên nhân gốc rễ
- Chế độ Tùy chỉnh: xây dựng các chế độ chuyên biệt cho nhóm hoặc quy trình làm việc của bạn

Xem thêm: [Sử dụng Chế độ](https://docs.zoocode.dev/basic-usage/using-modes) • [Chế độ tùy chỉnh](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Video hướng dẫn & tính năng

<div align="center">

|                                                                                                                                                                        |                                                                                                                                                                           |                                                                                                                                                                            |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <a href="https://www.youtube.com/watch?v=Mcq3r1EPZ-4"><img src="https://img.youtube.com/vi/Mcq3r1EPZ-4/maxresdefault.jpg" width="100%"></a><br><b>Cài đặt Zoo Code</b> | <a href="https://www.youtube.com/watch?v=ZBML8h5cCgo"><img src="https://img.youtube.com/vi/ZBML8h5cCgo/maxresdefault.jpg" width="100%"></a><br><b>Định cấu hình Hồ sơ</b> | <a href="https://www.youtube.com/watch?v=r1bpod1VWhg"><img src="https://img.youtube.com/vi/r1bpod1VWhg/maxresdefault.jpg" width="100%"></a><br><b>Lập chỉ mục cơ sở mã</b> |
| <a href="https://www.youtube.com/watch?v=iiAv1eKOaxk"><img src="https://img.youtube.com/vi/iiAv1eKOaxk/maxresdefault.jpg" width="100%"></a><br><b>Chế độ tùy chỉnh</b> |    <a href="https://www.youtube.com/watch?v=Ho30nyY332E"><img src="https://img.youtube.com/vi/Ho30nyY332E/maxresdefault.jpg" width="100%"></a><br><b>Điểm kiểm tra</b>    |   <a href="https://www.youtube.com/watch?v=HmnNSasv7T8"><img src="https://img.youtube.com/vi/HmnNSasv7T8/maxresdefault.jpg" width="100%"></a><br><b>Quản lý Ngữ cảnh</b>   |

</div>
<p align="center">
<a href="https://docs.zoocode.dev/tutorial-videos">Thêm video hướng dẫn và tính năng nhanh...</a>
</p>

## Tài nguyên

- **[Tài liệu](https://docs.zoocode.dev):** Hướng dẫn chính thức để cài đặt, cấu hình và sử dụng thành thạo Zoo Code.
- **[Kênh YouTube](https://youtube.com/@roocodeyt?feature=shared):** Xem các video hướng dẫn và các tính năng đang hoạt động.
- **[Máy chủ Discord](https://discord.gg/VxfP4Vx3gX):** Tham gia cộng đồng để được trợ giúp và thảo luận trong thời gian thực.
- **[Cộng đồng Reddit](https://www.reddit.com/r/ZooCode):** Chia sẻ kinh nghiệm của bạn và xem những người khác đang xây dựng gì.
- **[Vấn đề trên GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Báo cáo lỗi và theo dõi quá trình phát triển.
- **[Yêu cầu tính năng](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Có ý tưởng? Hãy chia sẻ với các nhà phát triển.

---

## Cài đặt và phát triển cục bộ

1. **Sao chép** kho lưu trữ:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Cài đặt các dependency**:

```sh
pnpm install
```

3. **Chạy phần mở rộng**:

Có một số cách để chạy phần mở rộng Zoo Code:

### Chế độ phát triển (F5)

Để phát triển tích cực, hãy sử dụng tính năng gỡ lỗi tích hợp của VSCode:

Nhấn `F5` (hoặc vào **Run** → **Start Debugging**) trong VSCode. Thao tác này sẽ mở một cửa sổ VSCode mới với phần mở rộng Zoo Code đang chạy.

- Các thay đổi đối với webview sẽ xuất hiện ngay lập tức.
- Các thay đổi đối với phần mở rộng cốt lõi cũng sẽ tự động được tải lại nóng.

### Cài đặt VSIX tự động

Để xây dựng và cài đặt phần mở rộng dưới dạng gói VSIX trực tiếp vào VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Lệnh này sẽ:

- Hỏi lệnh soạn thảo nào sẽ sử dụng (code/cursor/code-insiders) - mặc định là 'code'
- Gỡ cài đặt mọi phiên bản hiện có của phần mở rộng.
- Xây dựng gói VSIX mới nhất.
- Cài đặt VSIX vừa được xây dựng.
- Yêu cầu bạn khởi động lại VS Code để các thay đổi có hiệu lực.

Tùy chọn:

- `-y`: Bỏ qua tất cả các lời nhắc xác nhận và sử dụng các giá trị mặc định
- `--editor=<command>`: Chỉ định lệnh soạn thảo (ví dụ: `--editor=cursor` hoặc `--editor=code-insiders`)

### Cài đặt VSIX thủ công

Nếu bạn muốn cài đặt gói VSIX theo cách thủ công:

1.  Đầu tiên, hãy xây dựng gói VSIX:
    ```sh
    pnpm vsix
    ```
2.  Một tệp `.vsix` sẽ được tạo trong thư mục `bin/` (ví dụ: `bin/zoo-code-<version>.vsix`).
3.  Cài đặt thủ công bằng VSCode CLI:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Chúng tôi sử dụng [changesets](https://github.com/changesets/changesets) để quản lý phiên bản và xuất bản. Kiểm tra `CHANGELOG.md` của chúng tôi để biết ghi chú phát hành.

---

## Tuyên bố miễn trừ trách nhiệm

**Xin lưu ý** rằng Zoo Code **không** đưa ra bất kỳ tuyên bố hay bảo đảm nào liên quan đến bất kỳ mã, mô hình hoặc công cụ nào khác được cung cấp hoặc cung cấp liên quan đến Zoo Code, bất kỳ công cụ nào của bên thứ ba được liên kết hoặc bất kỳ kết quả đầu ra nào. Bạn chịu **mọi rủi ro** liên quan đến việc sử dụng bất kỳ công cụ hoặc kết quả đầu ra nào như vậy; các công cụ đó được cung cấp trên cơ sở **"NGUYÊN TRẠNG"** và **"NHƯ HIỆN CÓ"**. Những rủi ro đó có thể bao gồm, nhưng không giới hạn ở, vi phạm sở hữu trí tuệ, các lỗ hổng hoặc tấn công mạng, thiên vị, không chính xác, lỗi, khiếm khuyết, vi-rút, thời gian ngừng hoạt động, mất mát hoặc hư hỏng tài sản và/hoặc thương tích cá nhân. Bạn hoàn toàn chịu trách nhiệm về việc sử dụng bất kỳ công cụ hoặc kết quả đầu ra nào đó (bao gồm, nhưng không giới hạn ở, tính hợp pháp, tính phù hợp và kết quả của chúng).

---

## Đóng góp

Chúng tôi yêu thích những đóng góp của cộng đồng! Bắt đầu bằng cách đọc [CONTRIBUTING.md](CONTRIBUTING.md) của chúng tôi.

---

## Giấy phép

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Hãy tận hưởng Zoo Code!** Dù bạn giữ nó trong tầm kiểm soát hay để nó tự do hoạt động, chúng tôi rất nóng lòng muốn xem bạn sẽ xây dựng điều gì. Nếu bạn có câu hỏi hoặc ý tưởng tính năng, hãy mở một [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) hoặc bắt đầu một [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Chúc bạn code vui vẻ!
