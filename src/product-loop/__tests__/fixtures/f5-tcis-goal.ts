/**
 * The REAL goal of run `mttwpmu8ee5b`, read verbatim out of the run that
 * produced the F5 defect:
 *
 *   idea            D:\sources\CompanyLibs\tcis-libraries\.muonroi-flow\runs\
 *                   mttwpmu8ee5b\manifest.md  ("Idea:" line)
 *   successCriteria the same run's phases.md, `phases[].successCriteria`
 *                   flattened in phase order (P1…P5)
 *
 * Nothing here is paraphrased or tidied. The gate's whole claim is that it can
 * read what the user actually wrote — including the typos ("codestardand",
 * "tcis-librarie") and the mixed Vietnamese/English — so the fixture must carry
 * the text exactly as the run carried it.
 */

/** `manifest.md` → `Idea:` — the user's own words, verbatim. */
export const F5_IDEA =
  "ok bây giờ theo yêu cầu thì tôi cần phát triển 1 bộ coding rule dùng AOT để bắt ( ứng dụng polisher để bắt các " +
  "customs rule của công ty ) tôi có làm mẫu ở D:\\sources\\Core\\muonroi-building-block rule công ty muốn bắt sớm " +
  "khi dev code là @Nguyễn Văn Dũng @Phi Lê Quy tắc xuống dòng và cách dòng 1. Compact Code ngắn, đơn giản, dễ đọc " +
  "thì giữ trên một dòng. 2. Length-based wrapping Giới hạn tối đa 150 ký tự/dòng. Khi dòng quá dài, xuống dòng hợp " +
  "lý để đảm bảo dễ đọc. 3. Semantic wrapping Có thể chủ động xuống dòng trước 150 ký tự nếu giúp thể hiện rõ cấu " +
  "trúc hoặc logic. Khi đã xuống dòng, trình bày nhất quán: mỗi parameter, argument, condition hoặc fluent operation " +
  "trên một dòng. 4. Semantic grouping Dùng một dòng trống để phân tách các nhóm logic khác nhau. Các câu lệnh ngắn, " +
  "cùng một mục đích thì viết liền nhau. Với các câu lệnh dài nhiều dòng, có thể chèn một dòng trống giữa các câu " +
  "lệnh để tăng khả năng đọc, kể cả khi chúng cùng nhóm logic. Không dùng nhiều dòng trống liên tiếp. Nguyên tắc " +
  "chung: Ưu tiên code ngắn gọn nhưng phải dễ đọc, dễ review, nhất quán và thể hiện rõ cấu trúc logic. bạn cần triển " +
  "khai tại D:\\sources\\CompanyLibs\\tcis-librarie ( đây là nơi cần tìm hiểu và làm, muonroi-building-block chỉ là " +
  "source code tham khảo ) mong đợi tất cả dự án cài đặt bộ thư viện codestardand chuẩn mà bạn sắp triển khai trong " +
  "D:\\sources\\CompanyLibs\\tcis-librarie sẽ bắt được warn các vấn đề nêu trên mong đợi là khi vi phạm thì sẽ báo " +
  "warning trong visual studio";

/** `phases.md` → every `successCriteria` entry, P1…P5, in order. */
export const F5_SUCCESS_CRITERIA: readonly string[] = [
  "Visual Studio hiển thị warning khi dòng code vượt quá 150 ký tự",
  "Visual Studio hiển thị warning khi code ngắn, đơn giản bị tách thành nhiều dòng không cần thiết",
  "Visual Studio hiển thị warning khi thiếu dòng trống phân tách các nhóm logic khác nhau hoặc có nhiều dòng trống liên tiếp",
  "Visual Studio hiển thị warning khi parameter, argument, condition hoặc fluent operation không được trình bày trên một dòng sau khi xuống dòng",
  "Bộ analyzer có thể được đóng gói thành NuGet package và cài đặt thành công vào các dự án C# khác",
];

export const F5_GOAL = { idea: F5_IDEA, successCriteria: F5_SUCCESS_CRITERIA };
